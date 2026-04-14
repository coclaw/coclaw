---
disable-model-invocation: true
---

# /plugin-preflight — openclaw-coclaw 插件 npm 发布前兜底检查

## 定位

**用途**：准备发布 `openclaw-coclaw` 插件新版本**前**的安全断言。只做检查、只出报告，**不涉及**版本 bump、发布流程编排。

**与 /deep-review 的关系**：每个改动在合并时应该已经过 /deep-review。本命令是在其之上的**单次**专项断言，专盯"装上后出问题能不能再升级修复"的可回滚性。

**严格约束**（读完立刻在工作记忆里记下）：
- 只读审查；**不修改任何代码**
- **不 commit**、**不发布**、**不跑会改代码的命令**（如 `pnpm fix`、`pnpm verify --fix` 等）
- **不代替用户决定是否/如何发布**——版本 bump、changeset、release 脚本调用由用户自行决策
- 典型情况下**一次审查即可**，不做迭代循环
- **非阻障性问题只列不修**

## 核心不变量（blocker 的根本依据）

这是本命令永恒关心的断言，**不会随代码演进而失效**。后续代码怎么改，也必须保住这几条：

1. **加载不变量**：新版本插件能被当前 gateway API 同步加载完毕、`register()` 不抛异常
2. **自愈不变量**：自动升级链路完整——用户旧版 `AutoUpgradeScheduler` 能发现新版 → 下载 → 安装 → 验证；若本次出问题，下次还能继续尝试升级
3. **可达性不变量**：npm tarball 里真实包含运行所需的所有文件（入口 + 同步 require 链 + manifest）
4. **回滚不变量**：升级失败时的回滚兜底仍能把失败的安装回退到旧版

**违反上述任一条 → blocker。** 这是封闭断言，不是清单。

## 审查方法论（怎么审，而非审什么）

**不要只对着清单打勾**——清单只是起点，代码演进会带来新的风险面。正确的姿势：

1. **先读权威禁令**：`plugins/openclaw/CLAUDE.md` 的"绝对禁止清单"是项目踩过的坑的沉淀，新违规往往就是 blocker
2. **历史踩坑补课**：`plugins/openclaw/docs/auto-upgrade-review-*.md`（若存在）记录了自动升级相关的已知风险，顺带一读
3. **定位本次 diff**：用 `git log/diff <上次发布 tag>..HEAD -- plugins/openclaw` 看本次改了什么。发布 tag 可能形如 `openclaw-coclaw@X.Y.Z`，或通过 `git log --all --grep='publish @coclaw/openclaw-coclaw' -n 1` 找最近一次发布 commit
4. **对每块改动按不变量追问**：
   - 若这块改动带 bug，用户装上后 gateway 还能起来吗？（加载不变量）
   - 若起不来了，自动升级 scheduler 还能跑吗？它能发现并尝试下一个版本吗？（自愈不变量）
   - 发布出去的 npm 包里真有这些代码吗？（可达性不变量）
   - 升级失败时回滚兜底还能用吗？（回滚不变量）
5. **确认核心资产仍完整**：即便本次没改 auto-upgrade 相关代码，也要确认它仍在位——没被误删、没被其它改动间接破坏
6. **识别新风险面**：本次 diff 若触及了"已知风险点"之外的领域（如新引入了某个依赖、改了 service 注册方式、调整了 gateway method 签名），要从不变量角度独立判断是否引入新的 blocker

**切忌**：看到列表里没列出的东西就放过。列表不是免责清单。

## 当前已知高风险点（示例，非详尽）

以下是截至文档写作时已识别的风险面。**代码会演进，未来新的风险可能不在列**，此时应基于上节方法论独立判断。

> 这里列出的每一条仅作为"遇到这种情况基本就是 blocker"的模式识别参考。审查时不要只核对它们，要从不变量本身出发。

### 加载不变量相关

- `register()` 同步路径里存在可能抛异常的操作，无 try-catch
- `register()` 内直接启动 WebSocket / `setInterval` / 外部 IO（违反 `plugins/openclaw/CLAUDE.md` 禁令）
- 默认导出缺少 `id` 或 `register`；或 `register` 返回 Promise / 有顶层 `await`
- `plugin.id` 与 `openclaw.plugin.json` 的 `id` 不一致
- gateway method 错误响应用了旧格式 `respond(false, { error })`（禁令要求 `respond(false, undefined, { code, message })`）
- 引入了只在**未发布**版本 gateway 才有的 API

### 自愈不变量相关

- `coclaw.upgradeHealth` gateway method 被删，或返回对象不再含 `version: string`
- `AutoUpgradeScheduler` 不再作为 service 注册
- `upgrade-state.json` 里既有字段（如 `skippedVersions`、`lastCheck`、`lastRunAt`）被删或改名；或新增字段未考虑旧版兼容
- `worker.js` 调用的 `openclaw` CLI 参数格式变了（注意：这里看的是"当前发布版本的 worker.js 会调用什么 CLI"；用户装的是旧版，旧版 worker.js 跑的是旧 CLI 格式——所以真正的风险是"本次发布到这些 CLI 命令定义的变更，使得**未来**下一次升级的 worker.js 无法生效"）
- 自动升级的版本探测逻辑（`npm view @coclaw/openclaw-coclaw version` 等）被改坏

### 可达性不变量相关

- `package.json.main` 指向的文件被 `.npmignore` 或 `package.json.files` 字段排除
- 入口的同步 require 链里有本地文件被排除
- 建议跑 `pnpm -C plugins/openclaw pack --dry-run` 看实际将打包的文件清单（只读，不会真打包），确认关键路径都在

### 回滚不变量相关

- `fallbackInstallOldVersion`（或项目里的同等回滚机制）被删，或调用链破损
- 回滚用到的 CLI（如 `openclaw plugins install @coclaw/openclaw-coclaw@<旧版>`、`openclaw plugins uninstall <id>`）参数格式变了
- 升级相关锁文件（如 `upgrade.lock`）格式变了，导致锁永不释放

## 工作流

**一次性、单主 session 完成**（不做多轮迭代、不启 subagent）：

1. 读 `plugins/openclaw/CLAUDE.md` 的禁止清单
2. 扫 `plugins/openclaw/docs/` 里历史相关的 review / 风险记录
3. 读 `plugins/openclaw/package.json`、`index.js`、`openclaw.plugin.json`
4. 读 `plugins/openclaw/src/auto-upgrade/` 下所有文件，建立"当前的自动升级骨架长什么样"的心智模型
5. 取最近发布 tag 到 HEAD 的 diff；逐块改动按方法论第 4 步追问
6. （建议）跑 `pnpm -C plugins/openclaw pack --dry-run` 看 tarball 文件清单
7. （若可行）最小化 node load smoke：
   ```bash
   node -e "const p = require('/absolute/path/to/plugins/openclaw'); if (!p || typeof p.register !== 'function') { console.error('BAD export'); process.exit(1) }"
   ```
   抛异常 → 直接证明"加载不变量"被破坏，是 blocker
8. 按不变量维度累计 blockers 与 warnings
9. 输出报告

**不要**：审查中修问题、加临时注解、跑 lint/fix、尝试"只改一点点"把 warning 变 pass。

## 输出格式

```
插件 preflight 报告 (openclaw-coclaw)

─ Blockers (N)：违反核心不变量，拒绝发布
  1. <file:line> <问题描述>
     违反不变量：加载/自愈/可达性/回滚
     现象/后果：<一句话说清楚用户会遇到什么>
     建议修复方向：<一句话>
  2. ...

─ Warnings (M)：非阻障问题，仅记录
  1. <file:line> <问题描述>
  2. ...

─ 不变量核查
  加载不变量   [PASS / FAIL]   依据：<简述>
  自愈不变量   [PASS / FAIL]   依据：<简述>
  可达性不变量 [PASS / FAIL]   依据：<简述>
  回滚不变量   [PASS / FAIL]   依据：<简述>

─ 结论
  PASS → 未发现阻障问题；是否发布、如何 bump 版本由用户决定
  FAIL → 存在阻障问题；建议先修再考虑发布
```

结论 **PASS** 或 **FAIL** 二选一。有 warning 的 PASS 仍然是 PASS。

**下一步由用户决定**——本命令不触发 release、不建议具体版本号、不自动跑后续命令。

## 严禁

- 不改代码、不 commit、不发布
- 不跑 `pnpm fix` / `pnpm verify --fix` / `lint --fix` 类会改代码的命令
- 不尝试"帮用户顺手修 warning"
- 不做多轮迭代（审一次、报告一次，结束）
- 不把"当前已知高风险点"当封闭清单——不在示例里的新风险同样可能是 blocker，判定依据始终是"是否违反 4 条不变量之一"

## 参考

- 禁止清单权威：`plugins/openclaw/CLAUDE.md`
- 历史踩坑：`plugins/openclaw/docs/` 下的 review / risk 文档
- release 流程细节（仅供查阅，不调用）：`/release` skill
