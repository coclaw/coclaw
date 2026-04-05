# 文件浏览器（初版）

> 创建时间：2026-03-28
> 状态：已实施
> 范围：UI 侧文件浏览器功能设计（FTP）
> 前置依赖：`docs/designs/file-management.md`（文件管理协议）

---

## 一、概述

### 背景

文件管理协议（Plugin ↔ UI）和 UI 侧传输服务（`file-transfer.js`）已就绪。需要在此基础上构建文件浏览器 UI，让用户在 CoClaw App 中管理各 Agent Workspace 中的文件。

### 目标

1. 用户能浏览 Agent Workspace 目录结构
2. 支持文件上传（含拖拽）/ 下载 / 删除，目录创建 / 删除
3. 上传下载带进度指示，支持取消
4. 多 Agent 的文件管理可同时进行
5. 移动端优先

### 初版不做

| 不做 | 原因 |
|------|------|
| 文件预览（图片 / 文本等） | 后续迭代 |
| 重命名 / 移动 | 需新增 RPC |
| 文件搜索 | 后续迭代 |
| 目录上传 / 下载 | 复杂度高 |
| 从文件管理器拖出到 OS | 浏览器无法支持 |
| 创建空文件 | 需求不明确 |
| Electron / Tauri 与 OS 的深度文件交换 | 初版不考虑 |

---

## 二、入口与路由

### 入口

两处均提供入口：

1. **ChatPage header**：文件管理图标按钮
2. **Claw 详情页**：文件管理入口

### 路由

```
files/:clawId/:agentId
```

与 `chat/:clawId/:agentId` 平行，agentId 作为路径段。

路由 meta：

```js
{
	path: 'files/:clawId/:agentId',
	name: 'files',
	component: FileManagerPage,
	meta: { requiresAuth: true, hideMobileNav: true },
}
```

目录层级不映射到 URL，由组件内部状态管理。理由：
- 目录可能很深，URL 过长
- 目录导航频繁，无需产生浏览器历史
- 刷新回到根目录可接受

---

## 三、架构分层

```
file-transfer.js           ← 纯传输函数（已有，无 Vue 依赖）
files.store.js             ← Pinia store：传输任务状态 + 协调逻辑
Vue 组件                    ← 展示层
```

### 为什么不单独抽 FileTaskManager class

- 消费者只有 Vue 组件，没有非 Vue 消费场景
- Pinia store 本身就是状态 + 逻辑的容器，actions 中组织异步逻辑符合其设计意图
- store 的 reactivity 天然驱动 UI 更新，无需 EventEmitter + subscribe 胶水
- 实际传输逻辑已在 `file-transfer.js` 中，store 只做协调和状态管理

若 store 后续膨胀，提取纯函数到 `utils/` 即可，不引入额外 class 层。

---

## 四、Store 设计（files.store.js）

### 核心状态

```js
state: () => ({
	// 传输任务 Map<taskId, Task>
	tasks: new Map(),
})
```

目录浏览状态（`currentDir`、`dirEntries` 等）由 FileManagerPage 组件自身管理——它是局部 UI 状态而非全局共享状态。tasks 需要全局管理，因为传输在后台持续、跨页面存活。

### Task 结构

```js
{
	id,               // crypto.randomUUID()
	type,             // 'upload' | 'download'
	clawId,
	agentId,
	dir,              // 所在目录（相对 workspace）
	fileName,         // 文件名
	status,           // 'pending' | 'running' | 'done' | 'failed' | 'cancelled'
	progress,         // 0~1
	size,             // 文件总大小（字节）
	error,            // 失败时的错误信息
	file,             // upload 时：原始 File 对象引用（用于失败重试）
	transferHandle,   // { promise, cancel, onProgress } 来自 file-transfer.js
	createdAt,
}
```

### 关键 Actions

```js
// 入队上传（传入已解决重名冲突的文件列表）
enqueueUploads(clawId, agentId, dir, files)

// 入队下载（重复入队同一文件自动跳过）
enqueueDownload(clawId, agentId, dir, fileName, size)

// 取消任务
cancelTask(taskId)

// 重试失败任务
retryTask(taskId)

// 清理指定 agent 已完成/取消/失败的任务
clearFinished(clawId, agentId)
```

### 关键 Getters

```js
// 获取指定目录下的活跃任务（用于列表项合并展示）
getActiveTasks(clawId, agentId, dir)

// 获取指定 agent 的全部任务（用于全局进度指示）
getAgentTasks(clawId, agentId)
```

### 上传队列机制

同一 (clawId, agentId) 下的上传任务串行执行：
- `enqueueUploads` 将多个文件创建为 `pending` 状态的 task
- 内部维护执行循环：取出下一个 `pending` task → 调用 `file-transfer.js` 的 `uploadFile()` → 更新进度 → 完成/失败 → 取下一个
- 下载任务可并行（每次下载创建独立 DC，互不干扰）

---

## 五、交互设计

### 5.1 页面布局

```
┌─ MobilePageHeader（移动端）──────────────────┐
│  ← 返回    Agent 文件                        │
├──────────────────────────────────────────────┤
│  面包屑：/ src / components /                │
│  操作栏：[上传] [新建目录]                     │
├──────────────────────────────────────────────┤
│  📁 utils/                        2026-03-27 │
│  📁 views/                        2026-03-26 │
│  📄 App.vue              1.2KB    2026-03-28 │
│  📄 main.js              340B     2026-03-25 │
│  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ │
│  ⬆ report.pdf    ████████░░  78%    [✕]     │  ← 上传中的虚拟条目
│  ⬆ notes.txt     pending                    │  ← 排队中
├──────────────────────────────────────────────┤
│           （拖拽文件到此处上传）                │  ← 拖拽蒙层（dragover 时显示）
└──────────────────────────────────────────────┘
```

### 5.2 目录浏览

- 单层列表，点击目录进入下一层
- 面包屑导航支持跳转到任意父级
- 列表项信息：图标（目录/文件）、名称、大小（仅文件）、修改时间
- 目录排前、文件排后

### 5.3 进度指示与取消

**进度就地显示在文件列表中**：

- **上传中**：以虚拟条目形式插入当前目录列表底部，显示文件名 + 进度条 + 取消按钮
- **下载中**：在对应文件的列表项上叠加进度条 + 取消按钮
- **排队中（pending）**：显示 "pending" 状态文字
- **完成**：上传完成后虚拟条目消失，刷新目录列表展示真实文件；下载完成后进度条消失
- **失败**：显示错误提示 + 重试按钮

**目录切换时的进度保留**：

组件挂载时通过 `files.store` 的 `getActiveTasks(clawId, agentId, dir)` 查询当前目录下的活跃任务，合并到目录列表中展示。任务生命周期与组件解耦。

### 5.4 文件上传流程

```
用户点击上传 / 拖拽文件到浏览器
    │
    ▼
获取文件列表（File[]）
    │
    ▼
调用 listFiles() 获取当前目录已有文件
    │
    ▼
对比文件名，检测重名
    │
    ├── 无重名 → 直接入队
    │
    └── 有重名 → 弹出重名对话框（见 5.5）
                    │
                    ▼
              用户确认后入队
    │
    ▼
store.enqueueUploads() → 串行执行上传
```

### 5.5 重名处理对话框

```
┌──────────────────────────────────────┐
│ 以下文件在目标目录中已存在：            │
│                                      │
│  report.pdf     ○ 覆盖  ● 跳过      │
│  notes.txt      ○ 覆盖  ● 跳过      │
│  image.png      ○ 覆盖  ● 跳过      │
│                                      │
│  ☐ 将此选择应用于所有冲突文件          │
│                                      │
│              [取消]  [确认]           │
└──────────────────────────────────────┘
```

- 默认全部预选为"跳过"（安全优先）
- 未勾选"应用于全部"时：用户需逐项选择
- 勾选"应用于全部"后：对任一项的选择自动应用到所有未决项，直接确认
- 确认后：跳过的文件从上传列表中移除，覆盖的文件正常入队上传（PUT 语义，静默覆盖）

### 5.6 文件下载流程

```
用户点击文件
    │
    ▼
store.enqueueDownload()
    │
    ▼
file-transfer.js downloadFile()
    │ WebRTC DC 接收 chunks
    │ 列表项上显示进度条
    ▼
接收完成 → new Blob(chunks)
    │
    ▼
创建 <a download> + URL.createObjectURL → 触发浏览器保存
```

进度在 WebRTC DC 接收阶段显示（`receivedBytes / totalSize`）。Blob 组装和浏览器保存几乎瞬间完成。

### 5.7 删除文件

点击删除 → confirm 对话框 → 确认后调用 `coclaw.files.delete` → 刷新目录列表。

### 5.8 删除目录

点击删除 → **checkbox confirm 对话框**：

```
┌──────────────────────────────────────┐
│ 删除目录                              │
│                                      │
│ 确定要删除目录 "old-docs" 及其所有     │
│ 内容吗？                              │
│                                      │
│ ☐ 我了解此操作不可撤销                 │
│                                      │
│              [取消]  [删除]           │
└──────────────────────────────────────┘
```

- 必须勾选复选框后"删除"按钮才可点击
- "删除"按钮 destructive 风格（红色）
- 调用 `coclaw.files.delete` 时传递 `force: true`

### 5.9 创建目录

点击"新建目录" → prompt 对话框输入目录名 → 调用 `coclaw.files.mkdir` → 刷新目录列表。

### 5.10 拖拽上传

文件管理器区域监听 `dragover` / `dragleave` / `drop` 事件：

- `dragover`：显示蒙层提示"松开以上传文件"
- `dragleave`：隐藏蒙层
- `drop`：取 `event.dataTransfer.files` → 走正常上传流程（含重名检测）

仅支持文件拖入，不支持目录拖入（初版）。

---

## 六、移动端 App 后台恢复

移动端 App 切后台时，OS 可能挂起或断开 WebRTC 连接，导致传输中断。

**初版策略**：

1. 传输中的 task 检测到 DC 关闭（非用户取消）→ 标记为 `failed`
2. 失败的 upload task 保留原始 `File` 对象引用（页面未刷新时有效）
3. 用户切回 App → WebRTC 自动重连
4. 用户可在 UI 上对失败任务点"重试"
5. **不做自动重试**——避免在用户不知情时消耗流量

---

## 七、组件结构（参考）

```
FileManagerPage.vue          ← 路由页面：面包屑 + 操作栏 + 列表 + 拖拽蒙层
  ├── FileBreadcrumb.vue     ← 面包屑导航
  ├── FileListItem.vue       ← 文件/目录列表项（含进度态）
  ├── FileUploadItem.vue     ← 上传中的虚拟列表项
  └── 对话框（函数式调用）
       ├── 重名处理对话框
       ├── 删除目录 checkbox confirm
       └── 新建目录 prompt
```

遵循移动端优先设计，MobilePageHeader 提供返回导航。

---

## 八、依赖

| 需求 | 方案 | 新依赖 |
|------|------|--------|
| 文件传输 | `file-transfer.js`（已有） | 否 |
| 状态管理 | Pinia store | 否 |
| 对话框 | `useOverlay` / `UModal`（已有） | 否 |
| 拖拽 | 浏览器原生 drag events | 否 |
| 下载触发 | `<a download>` + Blob URL | 否 |

**不需要任何新的第三方依赖。**
