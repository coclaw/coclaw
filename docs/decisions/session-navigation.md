# CoClaw 会话导航模型设计方案对比

> 更新时间：2026-03-03
> 背景：CoClaw UI 以 sessionId（transcript 文件）为会话单位，但 OpenClaw 以 sessionKey（逻辑桶）为会话单位。两者之间存在语义差异，尤其在 sessionId 轮转时会产生不一致。

---

## 核心矛盾

- CoClaw Topics 列表展示的是 **sessionId 列表**（含 cron、orphan、归档等混合内容）
- 用户从中选 sessionId 进入对话，但发送走 `agent(sessionKey)` → 回复可能写入**另一个** sessionId
- 根源：导航以 sessionId 为单位，但 OpenClaw 的会话路由以 sessionKey 为单位

---

## 方案 A：以 sessionKey 为导航单位

**核心**：UI 的"对话"概念对应 sessionKey 而非 sessionId。

- 点击 bot → 进入 `agent:main:main` 的**当前** session
- Topics 列表 → 展示有意义的 sessionKey，过滤掉 cron/系统 key
- 每个 key 只展示其当前 sessionId 的消息
- 旧 sessionId 作为只读归档

**优点**：彻底消除轮转不一致；与 OpenClaw 语义完全对齐；用户心智最简单
**缺点**：需要较大 UI/导航重构；归档历史需单独入口
**适合阶段**：长期目标

---

## 方案 B：保持 sessionId 导航 + 轮转检测修复

**核心**：保持现有 Topics 以 sessionId 为单位，发送前检测轮转。

- 发送前调 `chat.history(sessionKey, limit=1)` 获取当前 sessionId
- 与当前浏览的 sessionId 对比
- 一致 → 正常发送 `agent(sessionKey)`
- 不一致 → 回退 `agent(sessionId)`（orphan 路径）+ 通知用户 + 刷新列表

**优点**：改动小；保持现有架构
**缺点**：每次发送多一次 RPC 调用；轮转提示可能让用户困惑；根本问题未解决
**适合阶段**：过渡方案

---

## 方案 C：混合导航（bot 入口 + 归档列表）

**核心**：区分"活跃对话"（by sessionKey）和"历史浏览"（by sessionId）。

- 点击 bot → 进入 `agent:main:main` 当前 session
- Topics/历史 → 展示所有 session，点进去是历史浏览 + 可选 orphan 续聊
- 活跃对话页以 sessionKey 路由
- 历史浏览页以 sessionId 路由，只读或走 orphan

**优点**：主流程简洁；历史可访问但不干扰
**缺点**：两种路由模式增加前端复杂度
**适合阶段**：中期优化

---

## 当前采用方案：B/C 融合（务实渐进）

取 B 的轮转检测 + C 的 bot 入口导航，保留现有 sessionId 列表：

1. **点击 bot** → 导航到 `agent:main:main` 对应的当前 sessionId
2. **发送前检测** → 发现轮转时，回退到 `agent(sessionId)` 保持当前上下文
3. **轮转通知** → toast 告知用户，刷新列表使新 session 可见
4. **后续** → 提供 `/new` `/reset` 等效按钮，让用户主动控制上下文

详见实施文档。

---

## 演进路线

1. **当前阶段**：B/C 融合（本文档）
2. **中期**：方案 C（双入口导航，活跃 + 归档分离）
3. **长期**：方案 A（全面 sessionKey 导航，sessionId 对用户透明）
