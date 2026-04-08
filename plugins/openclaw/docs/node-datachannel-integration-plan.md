# node-datachannel 集成方案

> 创建时间：2026-03-31
> 状态：已实施（2026-03-31）— 以代码为准，本文档为设计过程记录
> 前置文档：`docs/study/webrtc-connection-research.md`（附录 B：选型评估）
> 后续文档：[node-datachannel 使用笔记](node-datachannel-notes.md) — 使用过程中的问题、排查和发现
>
> **实施后差异**：版本已升级至 v0.32.2；实际模块位于 `src/webrtc/ndc-preloader.js`（非 `src/ndc-preloader.js`）；API 为 `preloadNdc()` 返回 `{ PeerConnection, cleanup, impl }`；包含 werift 自动回退和 TURN credential percent-encoding wrapper；`initLogger` 已启用（Warning 级别）；迁移路径一步到位（跳过双轨阶段）。详见第七节"实施差异记录"。

---

## 一、核心挑战

OpenClaw 对插件依赖的安装强制使用 `--ignore-scripts`（安全策略），而 node-datachannel 依赖 install 脚本（`prebuild-install`）下载预编译 native binary。

```
OpenClaw 安装流程：npm install --omit=dev --silent --ignore-scripts
→ prebuild-install 不执行
→ build/Release/node_datachannel.node 不存在
→ 运行时 require 失败（MODULE_NOT_FOUND）
```

### 已验证的关键事实

- `--ignore-scripts` 安装后，包目录完整（JS 文件齐全），仅缺 `build/Release/` 目录
- `require.resolve('node-datachannel')` 正常工作（可定位包根路径）
- 手动将 native binary 复制到 `build/Release/node_datachannel.node` 后，模块正常加载
- ESM 动态 `import('node-datachannel/polyfill')` 正常工作
- native binary 完全自包含（OpenSSL、libdatachannel、libjuice、usrsctp 均静态链接），仅依赖 glibc 标准库

---

## 二、方案：运行时 Bootstrap + Vendor 预编译包

### 2.1 总体流程

```
构建阶段（我们的 CI / prepublishOnly）
  │
  ├─ 从 GitHub Releases 下载各平台预编译包
  ├─ 解压 .node 文件，存放到 vendor/ndc-prebuilds/<platform>-<arch>/
  └─ 随插件 npm 包一起发布

运行时（gateway 加载插件后）
  │
  ├─ register() 中启动后台微任务（fire-and-forget）
  ├─ 检测 process.platform + process.arch
  ├─ 从 vendor/ndc-prebuilds/ 复制对应 binary 到 node_modules/node-datachannel/build/Release/
  ├─ 动态 import('node-datachannel/polyfill') 加载模块
  ├─ 冒烟测试（创建 PC → createOffer → close）
  └─ 通过 remoteLog 报告各阶段结果
```

### 2.2 版本锁定

`package.json` 中必须使用**精确版本**：

```json
"node-datachannel": "0.32.1"
```

禁止使用 `^` 或 `~` 前缀。预编译 binary 与 npm 包版本必须严格一致，否则可能出现 ABI 不匹配导致 segfault 或加载失败。

版本升级流程：更新 npm 版本 → 重新下载对应版本的预编译包 → 一起提交。

### 2.3 预编译包清单

基于 v0.32.1，从 GitHub Releases 下载：

```
https://github.com/murat-dogan/node-datachannel/releases/tag/v0.32.1
```

| 文件 | 平台标识 | 优先级 | 解压大小 |
|---|---|---|---|
| `node-datachannel-v0.32.1-napi-v8-linux-x64.tar.gz` | `linux-x64` | 必选 | ~8.7 MB |
| `node-datachannel-v0.32.1-napi-v8-linux-arm64.tar.gz` | `linux-arm64` | 必选 | ~8.5 MB |
| `node-datachannel-v0.32.1-napi-v8-darwin-x64.tar.gz` | `darwin-x64` | 必选 | ~8.5 MB |
| `node-datachannel-v0.32.1-napi-v8-darwin-arm64.tar.gz` | `darwin-arm64` | 必选 | ~8.5 MB |
| `node-datachannel-v0.32.1-napi-v8-win32-x64.tar.gz` | `win32-x64` | 必选 | ~8 MB |
| `node-datachannel-v0.32.1-napi-v8-linux-arm.tar.gz` | `linux-arm` | 可选 | ~7.5 MB |
| `node-datachannel-v0.32.1-napi-v8-linuxmusl-x64.tar.gz` | `linuxmusl-x64` | 可选 | ~8 MB |
| `node-datachannel-v0.32.1-napi-v8-linuxmusl-arm64.tar.gz` | `linuxmusl-arm64` | 可选 | ~7.5 MB |

必选平台合计：~42 MB（解压后）。含可选平台：~65 MB。

### 2.4 Vendor 目录结构

```
plugins/openclaw/
  vendor/
    ndc-prebuilds/
      linux-x64/
        node_datachannel.node
      linux-arm64/
        node_datachannel.node
      linux-arm/
        node_datachannel.node
      linuxmusl-x64/
        node_datachannel.node
      linuxmusl-arm64/
        node_datachannel.node
      darwin-x64/
        node_datachannel.node
      darwin-arm64/
        node_datachannel.node
      win32-x64/
        node_datachannel.node
```

`.gitignore` 中排除 vendor 目录（binary 不入 git），通过构建脚本下载。发布到 npm 时通过 `files` 字段包含。

### 2.5 平台检测逻辑

```js
function detectPlatformKey() {
    const platform = process.platform;  // 'linux', 'darwin', 'win32'
    const arch = process.arch;          // 'x64', 'arm64', 'arm'

    // musl (Alpine) 检测
    if (platform === 'linux') {
        try {
            const lddOutput = execSync('ldd --version 2>&1', { encoding: 'utf8' });
            if (lddOutput.includes('musl')) {
                return `linuxmusl-${arch}`;
            }
        } catch {
            // ldd 失败时尝试检测 musl loader
            if (existsSync(`/lib/ld-musl-${arch === 'x64' ? 'x86_64' : arch}.so.1`)) {
                return `linuxmusl-${arch}`;
            }
        }
    }

    return `${platform}-${arch}`;
}
```

### 2.6 Bootstrap 模块（核心实现）

```js
// src/ndc-preloader.js

import { createRequire } from 'module';
import nodePath from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { remoteLog } from './remote-log.js';

const __dirname = nodePath.dirname(fileURLToPath(import.meta.url));

/**
 * 后台预加载 node-datachannel。
 * fire-and-forget 调用，所有异常内部捕获，不影响 gateway。
 *
 * @returns {{ available: boolean, RTCPeerConnection?: function, cleanup?: function, error?: string }}
 */
export async function preloadNodeDatachannel() {
    try {
        // 阶段 1：部署 native binary
        const deployed = deployBinary();
        if (!deployed.ok) {
            remoteLog(`ndc.unsupported-platform key=${deployed.key}`);
            return { available: false, error: `unsupported platform: ${deployed.key}` };
        }
        remoteLog(`ndc.binary-deployed key=${deployed.key}`);

        // 阶段 2：加载模块
        const polyfill = await import('node-datachannel/polyfill');
        const ndc = await import('node-datachannel');
        const { RTCPeerConnection } = polyfill;
        const cleanup = ndc.cleanup ?? ndc.default?.cleanup;
        remoteLog('ndc.module-loaded');

        // 阶段 3：冒烟测试
        const pc = new RTCPeerConnection({ iceServers: [] });
        pc.createDataChannel('__smoke');
        const offer = await pc.createOffer();
        pc.close();
        if (!offer?.sdp) throw new Error('smoke test: no SDP');
        remoteLog('ndc.ready');

        return { available: true, RTCPeerConnection, cleanup };
    } catch (err) {
        remoteLog(`ndc.init-failed msg=${err.message}`);
        return { available: false, error: err.message };
    }
}

function deployBinary() {
    const require = createRequire(import.meta.url);
    const entryPath = require.resolve('node-datachannel');
    const pkgRoot = nodePath.resolve(nodePath.dirname(entryPath), '../../..');
    const targetDir = nodePath.join(pkgRoot, 'build', 'Release');
    const targetFile = nodePath.join(targetDir, 'node_datachannel.node');

    // 已存在则跳过（正常 pnpm install 环境，或已执行过 bootstrap）
    if (fs.existsSync(targetFile)) {
        return { ok: true, key: 'already-present' };
    }

    const key = detectPlatformKey();
    const src = nodePath.join(__dirname, '..', 'vendor', 'ndc-prebuilds', key, 'node_datachannel.node');

    if (!fs.existsSync(src)) {
        return { ok: false, key };
    }

    fs.mkdirSync(targetDir, { recursive: true });
    fs.copyFileSync(src, targetFile);
    return { ok: true, key };
}
```

### 2.7 集成到 Plugin 生命周期

```js
// register() 中
let ndcResult = null;

// fire-and-forget，不阻塞 gateway 启动
preloadNodeDatachannel()
    .then(result => { ndcResult = result; })
    .catch(() => {});  // 内部已全捕获，此 catch 为防御性兜底
```

后续切换 WebRTC 实现时，检查 `ndcResult?.available` 决定使用 node-datachannel 还是 werift。

---

## 三、构建脚本（预编译包下载）

需要一个脚本在 CI 或 `prepublishOnly` 阶段下载预编译包：

```bash
#!/bin/bash
# scripts/download-ndc-prebuilds.sh

VERSION="0.32.1"
BASE_URL="https://github.com/murat-dogan/node-datachannel/releases/download/v${VERSION}"
DEST="vendor/ndc-prebuilds"

PLATFORMS=(
    "linux-x64"
    "linux-arm64"
    "darwin-x64"
    "darwin-arm64"
    "win32-x64"
    # 可选：
    # "linux-arm"
    # "linuxmusl-x64"
    # "linuxmusl-arm64"
)

for plat in "${PLATFORMS[@]}"; do
    url="${BASE_URL}/node-datachannel-v${VERSION}-napi-v8-${plat}.tar.gz"
    dir="${DEST}/${plat}"
    mkdir -p "${dir}"
    echo "Downloading ${plat}..."
    curl -sL "${url}" | tar xz -C "${dir}" --strip-components=2
    # tarball 内路径为 build/Release/node_datachannel.node，strip 2 层后直接得到文件
done

echo "All prebuilds downloaded to ${DEST}/"
ls -lhR "${DEST}/"
```

---

## 四、package.json 变更

```jsonc
{
    // 精确版本
    "dependencies": {
        "node-datachannel": "0.32.1"
    },
    // 确保 vendor 目录包含在 npm 发布中
    "files": [
        "dist/",
        "src/",
        "vendor/",
        "openclaw.plugin.json"
    ]
}
```

---

## 五、迁移路径（werift → node-datachannel）

### 阶段 1：预加载（本方案）

- 添加 node-datachannel 依赖和 vendor 预编译包
- 实现 `ndc-preloader.js` 后台预加载
- 通过 remoteLog 收集各平台加载结果
- **不改变现有 werift 路径**，仅验证 node-datachannel 可用性

### 阶段 2：双轨运行

- `webrtc-peer.js` 支持通过配置切换 RTCPeerConnection 实现
- 默认仍用 werift，可通过配置启用 node-datachannel
- 收集对比数据（连接建立时间、P2P/relay 比例、连接稳定性）

### 阶段 3：全面切换

- 确认 node-datachannel 稳定后，设为默认
- 移除 werift 依赖
- 更新文档

---

## 六、风险与注意事项

### 6.1 glibc 版本兼容性

预编译 binary 在特定 glibc 版本上构建。运行环境的 glibc 必须 >= 构建时版本。主流 Linux 发行版（Ubuntu 20.04+、Debian 11+、CentOS 8+）通常满足。极旧系统可能不兼容——此时 preload 的冒烟测试会捕获错误并报告。

### 6.2 node_modules 写权限

bootstrap 需要向 `node_modules/node-datachannel/build/Release/` 写文件。在常规部署中（npm/link 安装），插件进程对 node_modules 有写权限。若以只读文件系统运行（如某些容器化部署），需要在镜像构建阶段完成 binary 部署。

### 6.3 版本升级纪律

node-datachannel 的 npm 版本和 vendor 预编译包**必须严格同步**：
- 升级时同时更新 `package.json` 版本和重新下载预编译包
- CI 中应验证两者版本一致

### 6.4 进程退出

node-datachannel 的 `cleanup()` 函数需要在 gateway 停止时调用，否则 ThreadSafeCallback 可能阻止进程干净退出（open issue #366）。在 plugin 的 service stop 钩子中调用。

### 6.5 createOffer 需先 createDataChannel

验证中发现：不先 `createDataChannel()` 直接调用 `createOffer()` 会挂起。这与浏览器行为一致（无 media track / data channel 时 offer 无内容可协商）。冒烟测试中已处理。

### 6.6 异常捕获策略

preloader 中任何阶段的异常都必须被捕获，包括但不限于：
- `require.resolve` 失败（node-datachannel 未安装）
- binary 文件复制失败（权限问题）
- native binding 加载失败（ABI 不匹配、glibc 版本过低）
- 冒烟测试失败（createOffer 超时、SDP 为空）
- `import()` 抛出的模块加载错误

所有异常通过 remoteLog 报告，不向上抛出，不影响 gateway 正常运行。

---

## 七、实施差异记录

实际实施与原方案的主要差异：

1. **冒烟测试简化**：原方案设计了 `createDataChannel + createOffer + close` 的完整冒烟测试。实施中发现创建 RTCPeerConnection 实例会启动 native threads，如果调用方（如 `plugin-mode.test.js` 中的 bind 流程）没有显式调用 `cleanup()`，会阻止 Node 进程退出。改为仅验证 `typeof RTCPeerConnection === 'function'`，不创建实例。

2. **动态导入 ndc-preloader**：原方案在 `realtime-bridge.js` 顶层 `import { preloadNdc }` 静态导入。实施中发现 ESM 模块导入链会导致 `node --test` 环境下的进程退出问题。改为在 `start()` 方法中通过 `await import('./ndc-preloader.js')` 动态导入，避免影响不需要 WebRTC 的代码路径。

3. **stop() 中的 cleanup 增强**：原方案只在 `__initWebrtcPeer` 设置 `__ndcCleanup` 后由 `stop()` 调用。实施中发现如果 `start()` 触发了 preload 但 `__initWebrtcPeer` 未被调用（无 WebRTC offer），cleanup 引用未缓存。改为 `stop()` 中先检查 `__ndcCleanup`，若无则 await `__ndcPreloadPromise` 从结果中获取 cleanup。

4. **平台范围**：仅包含 5 个必选平台（linux-x64/arm64、darwin-x64/arm64、win32-x64）。经调研确认 OpenClaw 不支持 Alpine (musl) 和 armv7，排除了可选平台。

5. **迁移路径简化**：原方案分 3 阶段（预加载 → 双轨 → 全面切换）。实际一步到位实现了"优先 ndc，回退 werift"，跳过了双轨运行阶段。
