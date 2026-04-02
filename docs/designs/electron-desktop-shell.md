# Electron 桌面壳子应用设计方案

> 状态：草案
> 创建时间：2026-03-15
> 适用范围：Windows + macOS 桌面端
> 替代文档：`tauri-desktop-shell.md`（Tauri 方案已放弃，保留作参考）

## 技术选型变更说明

初始选型为 Tauri v2，已完成骨架搭建（`ui/src-tauri/`）。经评估后切换为 Electron，原因：

| 维度 | Tauri v2 | Electron | 结论 |
|---|---|---|---|
| 技术栈一致性 | Rust（壳子）+ JS（前端） | 全 JS | Electron 胜：团队全 JS，无 Rust 维护负担 |
| 交叉编译 | 不支持跨 OS 编译 | Windows 可从 Linux 编译；macOS 需 macOS | Electron 胜：WSL2 可直接产出 .exe |
| 原生 API 齐全度 | badge/overlay 需 Rust 自定义 command | `setOverlayIcon`、`setBadgeCount`、`flashFrame` 等均为内置 JS API | Electron 胜 |
| 安装包体积 | ~5-8 MB | ~80-150 MB | Tauri 胜，但远程加载场景下体积非核心痛点 |
| 内存占用 | 较低 | 较高 | Tauri 胜，但桌面端内存非瓶颈 |
| 渲染一致性 | Windows=Chromium, macOS=WebKit | 全平台 Chromium | Electron 胜：无跨引擎差异 |
| 生态成熟度 | 较新，社区较小 | 极成熟（VSCode/Slack/Discord 等） | Electron 胜 |

> 已有的 `src-tauri/` 目录保留不删除，不影响正常开发。

## 关键决策记录

### D1. 开发者账号类型

**决策**：两个平台均使用公司/组织账号，与 APK 发布主体一致（成都共演科技有限公司）。

| 平台 | 账号类型 | 费用 | 备注 |
|---|---|---|---|
| Microsoft Store | 公司 | $99 一次性 | 个人账号 $19，但以个人名义发布 |
| Apple Developer | 组织 | $99/年 | 需 D-U-N-S 编号 |

### D2. 代码签名策略

**决策**：Microsoft Store 走 AppX 路径（商店自动签名），官网直接下载版使用 OV 证书。

| 备选方案 | 优势 | 劣势 |
|---|---|---|
| **OV 证书（当前选择）** | 便宜 | SmartScreen 需积累信誉（2023.6 后 OV 不再直接消除警告） |
| EV 证书 | 立即 SmartScreen 信任 | 昂贵，需硬件 HSM（~$300-500/年） |
| Azure Trusted Signing | 云端签名，CI 友好 | 需 Azure 订阅，限美国/加拿大 3 年以上企业 |

**升级路径**：初期走商店分发（无需自购证书）+ OV 签名直接下载版。预算充足后升级 EV 或 Azure Trusted Signing。

### D3. 自动更新端点

**决策**：使用 GitHub Releases + `electron-updater`。

| 备选方案 | 优势 | 劣势 |
|---|---|---|
| **GitHub Releases（当前选择）** | 零成本，electron-builder 原生支持 | 国内访问可能受限 |
| 自建更新服务 | 完全可控 | 需维护额外服务 |
| Amazon S3 / DigitalOcean | electron-updater 原生支持 | 付费 |

### D4. macOS 最低版本

**决策**：最低 macOS 12.0 (Monterey)，构建 Universal Binary。

### D5. 构建工具链

**决策**：electron-builder + electron-updater。

| 备选方案 | 优势 | 劣势 |
|---|---|---|
| **electron-builder（当前选择）** | 成熟，auto-update 集成好，目标格式多 | 配置稍复杂 |
| electron-forge | Electron 官方工具 | auto-update 集成弱，目标格式较少 |

## 1. 设计目标

与 Android APK 壳子一致，遵循 **"薄壳远程加载"** 架构：

1. **壳子尽量少升级**：一次性预埋所有原生能力，后续功能迭代仅通过 Web 端（`https://im.coclaw.net`）更新
2. **前端代码零分歧**：桌面壳子与 Web/Android 共用同一套 Vue SPA
3. **覆盖完整能力矩阵**：麦克风、摄像头、屏幕截图、文件系统、剪贴板、通知、Deep Link、系统托盘、未读徽章、自动更新
4. **上架应用商店**：Microsoft Store + Apple Mac App Store

## 2. 壳子架构

```
┌───────────────────────────────────────────┐
│         Electron Main Process (JS)        │
│  ┌─────────────────────────────────────┐  │
│  │ BrowserWindow (Chromium)            │  │
│  │  loadURL('https://im.coclaw.net')   │  │
│  │  ┌─────────────────────────────┐    │  │
│  │  │ preload.js (contextBridge)  │    │  │
│  │  │  window.electronAPI = {...} │    │  │
│  │  └─────────────────────────────┘    │  │
│  └─────────────────────────────────────┘  │
│  ┌───────────┐ ┌──────────────────────┐   │
│  │ Tray + IPC│ │ Permission Handler   │   │
│  └───────────┘ └──────────────────────┘   │
│  ┌──────────────────────────────────────┐ │
│  │ electron-updater (auto-update)       │ │
│  └──────────────────────────────────────┘ │
└───────────────────────────────────────────┘
```

### 2.1 远程加载模式

```js
// main.js（简化）
const win = new BrowserWindow({
  webPreferences: {
    preload: path.join(__dirname, 'preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  }
});
win.loadURL('https://im.coclaw.net');
```

- 远程页面不能直接访问 Node.js 或 Electron API
- 所有原生能力通过 `preload.js` → `contextBridge` → `window.electronAPI` 暴露
- Web 端通过检测 `window.electronAPI` 判断是否运行在 Electron 壳子中

### 2.2 与 Android 壳子的对应关系

| Android 壳子 | Electron 壳子 | 说明 |
|---|---|---|
| `capacitor.config.ts` server.url | `win.loadURL(url)` | 远程加载入口 |
| AndroidManifest.xml 权限 | `session.setPermissionRequestHandler` | 权限授予 |
| Capacitor 插件 | preload.js + ipcMain handlers | 原生桥接 |
| KeepAliveService | 系统托盘常驻 | 后台保活 |
| Intent Filter (Deep Link) | `app.setAsDefaultProtocolClient` | `coclaw://` 协议 |
| `Capacitor.isNativePlatform()` | `!!window.electronAPI` | 平台检测 |

## 3. 项目结构

```
ui/
├── electron/
│   ├── main.js                # 主进程入口（含 createWindow、activate、Dock 菜单）
│   ├── preload.cjs            # 预加载脚本（contextBridge，CommonJS）
│   ├── tray.js                # 系统托盘逻辑
│   ├── ipc-handlers.js        # IPC 处理器注册（dialog/clipboard/badge/download/...）
│   ├── permissions.js         # 权限自动授予逻辑
│   ├── deep-link.js           # Deep Link 处理
│   ├── updater.js             # 自动更新逻辑
│   └── locale.js              # 系统语言检测与本地化文本
├── build-resources/
│   ├── icon.ico               # Windows 应用图标
│   ├── icon.icns              # macOS 应用图标
│   ├── icon.png               # 通用（1024×1024）
│   ├── tray-icon.png          # 托盘图标
│   ├── entitlements.mac.plist          # macOS Hardened Runtime 权限
│   └── entitlements.mac.inherit.plist  # macOS 子进程继承权限
├── electron-builder.yml       # electron-builder 配置
├── src/                       # 前端代码（现有，不变）
├── android/                   # Android 壳子（现有）
├── src-tauri/                 # Tauri 骨架（保留不动）
└── ...
```

## 4. 主进程实现

### 4.1 main.js — 应用入口

```js
// main.js（简化，完整代码见 electron/main.js）
import { app, BrowserWindow, Menu, session } from 'electron';
import windowStateKeeper from 'electron-window-state';
// ... 其他 import

const gotLock = setupSingleInstance(app);
if (!gotLock) {
  app.quit();
} else {
  // 窗口创建提取为函数，供 activate 事件复用
  function createWindow() {
    const mainWindowState = windowStateKeeper({ defaultWidth: 420, defaultHeight: 780 });
    const win = new BrowserWindow({
      /* ... 窗口配置 ... */
      ...(process.platform === 'darwin' && {
        titleBarStyle: 'hiddenInset',
        trafficLightPosition: { x: 10, y: 10 },
      }),
    });
    mainWindowState.manage(win);
    win.loadURL(isDev ? DEV_URL : REMOTE_URL);
    registerIpcHandlers(win);
    initTray(app, win);
    if (!isDev) initUpdater(win);
    return win;
  }

  app.whenReady().then(() => {
    if (process.platform === 'win32') app.setAppUserModelId('net.coclaw.im');

    // macOS：完整菜单栏（App + Edit + View + Window）+ Dock 菜单
    if (process.platform === 'darwin') {
      Menu.setApplicationMenu(Menu.buildFromTemplate([/* ... */]));
      app.dock.setMenu(Menu.buildFromTemplate([/* ... */]));
    } else {
      Menu.setApplicationMenu(null);
    }

    setupPermissions(session.defaultSession);
    registerProtocol(app);
    createWindow();
  });

  // macOS：点击 Dock 图标时，若无窗口则重建
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else {
      const win = BrowserWindow.getAllWindows()[0];
      win.show();
      win.focus();
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
```

### 4.2 preload.js — 暴露给远程页面的 API

```js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // ---- 平台信息 ----
  platform: process.platform,  // 'win32' | 'darwin' | 'linux'

  // ---- 壳子版本 ----
  getShellVersion: () => ipcRenderer.invoke('app:getShellVersion'),

  // ---- 对话框 ----
  openFile: (options) => ipcRenderer.invoke('dialog:openFile', options),
  saveFile: (options) => ipcRenderer.invoke('dialog:saveFile', options),

  // ---- 剪贴板 ----
  clipboardWriteText: (text) => ipcRenderer.invoke('clipboard:writeText', text),
  clipboardReadText: () => ipcRenderer.invoke('clipboard:readText'),
  clipboardWriteImage: (dataUrl) => ipcRenderer.invoke('clipboard:writeImage', dataUrl),
  clipboardReadImage: () => ipcRenderer.invoke('clipboard:readImage'),

  // ---- 通知 ----
  showNotification: (title, body, options) =>
    ipcRenderer.invoke('notification:show', title, body, options),

  // ---- 系统托盘 ----
  setTrayTooltip: (text) => ipcRenderer.send('tray:setTooltip', text),
  setTrayUnread: (hasUnread) => ipcRenderer.send('tray:setUnread', hasUnread),

  // ---- 任务栏/Dock ----
  flashFrame: (flag) => ipcRenderer.send('window:flashFrame', flag),
  setBadgeCount: (count) => ipcRenderer.send('app:setBadgeCount', count),
  setOverlayIcon: (dataUrl, description) =>
    ipcRenderer.send('window:setOverlayIcon', dataUrl, description),
  clearOverlayIcon: () => ipcRenderer.send('window:clearOverlayIcon'),

  // ---- 窗口 ----
  requestAttention: (type) => ipcRenderer.send('window:requestAttention', type),

  // ---- 外部链接 ----
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  // ---- 截图 ----
  getScreenSources: () => ipcRenderer.invoke('screenshot:getSources'),
  getScreenPermission: () => ipcRenderer.invoke('screenshot:checkPermission'),

  // ---- 下载 ----
  downloadFile: (url) => ipcRenderer.invoke('download:start', url),

  // ---- 设置 ----
  getSetting: (key) => ipcRenderer.invoke('store:get', key),
  setSetting: (key, value) => ipcRenderer.invoke('store:set', key, value),

  // ---- 事件监听（主进程 → 渲染进程）----
  onDeepLink: (cb) => ipcRenderer.on('deep-link', (_e, url) => cb(url)),
  onUpdateAvailable: (cb) => ipcRenderer.on('update-available', (_e, info) => cb(info)),
  onWindowFocus: (cb) => ipcRenderer.on('window-focus', () => cb()),
  onScreenshotTrigger: (cb) => ipcRenderer.on('screenshot-trigger', () => cb()),
  onDownloadProgress: (cb) => ipcRenderer.on('download:progress', (_e, info) => cb(info)),
  onDownloadDone: (cb) => ipcRenderer.on('download:done', (_e, info) => cb(info)),
});
```

### 4.3 permissions.js — 权限自动授予

```js
function setupPermissions(ses) {
  const TRUSTED_ORIGIN = 'im.coclaw.net';

  // 权限检查（同步）
  ses.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    try {
      const hostname = new URL(requestingOrigin).hostname;
      if (hostname === TRUSTED_ORIGIN || hostname.endsWith('.coclaw.net')) {
        return true;
      }
    } catch {}
    return false;
  });

  // 权限请求（异步）
  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    try {
      const url = details.requestingUrl || '';
      if (url.includes(TRUSTED_ORIGIN)) {
        callback(true);
        return;
      }
    } catch {}
    callback(false);
  });
}

module.exports = { setupPermissions };
```

此处对 `*.coclaw.net` 域的所有权限请求（麦克风、摄像头、通知、剪贴板等）自动批准，无需用户交互。这对标 Android 壳子中 `AndroidManifest.xml` 的权限预声明。

### 4.4 ipc-handlers.js — IPC 处理器

```js
const { ipcMain, dialog, clipboard, shell, nativeImage, Notification } = require('electron');

function registerIpcHandlers(win) {
  // ---- 对话框 ----
  ipcMain.handle('dialog:openFile', async (_, options) => {
    return dialog.showOpenDialog(win, options);
  });
  ipcMain.handle('dialog:saveFile', async (_, options) => {
    return dialog.showSaveDialog(win, options);
  });

  // ---- 剪贴板 ----
  ipcMain.handle('clipboard:writeText', (_, text) => clipboard.writeText(text));
  ipcMain.handle('clipboard:readText', () => clipboard.readText());
  ipcMain.handle('clipboard:writeImage', (_, dataUrl) => {
    clipboard.writeImage(nativeImage.createFromDataURL(dataUrl));
  });
  ipcMain.handle('clipboard:readImage', () => {
    const img = clipboard.readImage();
    return img.isEmpty() ? null : img.toDataURL();
  });

  // ---- 通知 ----
  ipcMain.handle('notification:show', (_, title, body, options = {}) => {
    const notif = new Notification({ title, body, ...options });
    notif.on('click', () => { win.show(); win.focus(); });
    notif.show();
  });

  // ---- 外部链接 ----
  ipcMain.handle('shell:openExternal', (_, url) => shell.openExternal(url));

  // ---- 任务栏/Dock ----
  ipcMain.on('window:flashFrame', (_, flag) => win.flashFrame(flag));
  ipcMain.on('app:setBadgeCount', (_, count) => {
    if (process.platform === 'darwin') {
      app.setBadgeCount(count);
    }
  });
  ipcMain.on('window:setOverlayIcon', (_, dataUrl, desc) => {
    if (process.platform === 'win32') {
      win.setOverlayIcon(nativeImage.createFromDataURL(dataUrl), desc);
    }
  });
  ipcMain.on('window:clearOverlayIcon', () => {
    if (process.platform === 'win32') {
      win.setOverlayIcon(null, '');
    }
  });
  ipcMain.on('window:requestAttention', (_, type) => {
    if (process.platform === 'darwin') {
      app.dock.bounce(type === 'critical' ? 'critical' : 'informational');
    } else {
      win.flashFrame(true);
    }
  });

  // ---- 设置 ----
  const Store = require('electron-store');
  const store = new Store();
  ipcMain.handle('store:get', (_, key) => store.get(key));
  ipcMain.handle('store:set', (_, key, value) => store.set(key, value));
}

module.exports = { registerIpcHandlers };
```

### 4.5 tray.js — 系统托盘

```js
const { Tray, Menu, nativeImage } = require('electron');
const path = require('node:path');

let tray = null;
let isUnread = false;
let flashTimer = null;

function initTray(app, win) {
  const iconPath = path.join(__dirname, '../build-resources/tray-icon.png');
  const unreadIconPath = path.join(__dirname, '../build-resources/tray-icon-unread.png');

  const normalIcon = nativeImage.createFromPath(iconPath);
  const unreadIcon = nativeImage.createFromPath(unreadIconPath);

  // macOS template image
  if (process.platform === 'darwin') {
    normalIcon.setTemplateImage(true);
    unreadIcon.setTemplateImage(true);
  }

  tray = new Tray(normalIcon);
  tray.setToolTip('CoClaw');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示窗口',
      click: () => { win.show(); win.focus(); },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(contextMenu);

  // 左键单击：显示/隐藏窗口
  tray.on('click', () => {
    if (win.isVisible()) {
      win.hide();
    } else {
      win.show();
      win.focus();
    }
  });

  // 关闭窗口 → 根据设置隐藏到托盘或退出
  win.on('close', (event) => {
    if (app.isQuitting) return;
    const Store = require('electron-store');
    const store = new Store();
    const minimizeToTray = store.get('minimize_to_tray', true);
    if (minimizeToTray) {
      event.preventDefault();
      win.hide();
    }
  });

  // ---- IPC：托盘状态更新 ----
  const { ipcMain } = require('electron');

  ipcMain.on('tray:setTooltip', (_, text) => {
    tray.setToolTip(text);
  });

  ipcMain.on('tray:setUnread', (_, hasUnread) => {
    if (hasUnread && !isUnread) {
      isUnread = true;
      startFlash();
    } else if (!hasUnread && isUnread) {
      isUnread = false;
      stopFlash();
    }
  });

  function startFlash() {
    let toggle = false;
    flashTimer = setInterval(() => {
      tray.setImage(toggle ? normalIcon : unreadIcon);
      if (process.platform === 'darwin') {
        tray.image.setTemplateImage(true);
      }
      toggle = !toggle;
    }, 500);
  }

  function stopFlash() {
    if (flashTimer) {
      clearInterval(flashTimer);
      flashTimer = null;
    }
    tray.setImage(normalIcon);
    if (process.platform === 'darwin') {
      tray.image.setTemplateImage(true);
    }
  }

  // 窗口获焦时停止闪动
  win.on('focus', () => {
    if (isUnread) {
      // 通知 Web 端窗口已获焦，由 Web 端决定是否清除未读状态
      win.webContents.send('window-focus');
    }
  });
}

module.exports = { initTray };
```

### 4.6 deep-link.js — Deep Link 处理

```js
const PROTOCOL = 'coclaw';

function setupSingleInstance(app) {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) return false;

  // Windows/Linux：第二个实例传入 Deep Link URL
  app.on('second-instance', (event, commandLine) => {
    const url = commandLine.find(arg => arg.startsWith(`${PROTOCOL}://`));
    if (url) handleDeepLink(url);
    // 聚焦已有窗口
    const { BrowserWindow } = require('electron');
    const win = BrowserWindow.getAllWindows()[0];
    if (win) { win.show(); win.focus(); }
  });

  return true;
}

function handleDeepLink(url) {
  // coclaw://chat/xxx → 通知渲染进程导航
  const { BrowserWindow } = require('electron');
  const win = BrowserWindow.getAllWindows()[0];
  if (win) {
    win.webContents.send('deep-link', url);
  }
}

function registerProtocol(app) {
  if (process.defaultApp) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [
      require('node:path').resolve(process.argv[1])
    ]);
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL);
  }

  // macOS：通过 open-url 事件接收
  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
  });
}

module.exports = { setupSingleInstance, handleDeepLink, registerProtocol };
```

### 4.7 updater.js — 自动更新

```js
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');

function initUpdater() {
  autoUpdater.logger = log;
  autoUpdater.autoDownload = false; // 让用户确认后再下载

  autoUpdater.on('update-available', (info) => {
    const { BrowserWindow } = require('electron');
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      win.webContents.send('update-available', {
        version: info.version,
        releaseNotes: info.releaseNotes,
      });
    }
  });

  // 定期检查更新（每 4 小时）
  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, 4 * 60 * 60 * 1000);
}

module.exports = { initUpdater };
```

## 5. 安全模型

### 5.1 webPreferences 安全配置

| 配置项 | 值 | 说明 |
|---|---|---|
| `contextIsolation` | `true` | 预加载脚本与页面 JS 隔离（Electron 12+ 默认） |
| `nodeIntegration` | `false` | 禁止远程页面访问 Node.js |
| `sandbox` | `true` | 渲染进程沙箱化（Electron 20+ 默认） |
| `webSecurity` | `true` | 保持同源策略 |

### 5.2 API 暴露原则

- 仅通过 `contextBridge.exposeInMainWorld` 暴露具名方法
- 绝不暴露 `ipcRenderer` 本身
- 每个 IPC channel 对应一个具体操作，不暴露通用 `invoke` 能力
- 主进程 handler 中验证参数合理性

### 5.3 导航限制

```js
// 阻止导航到非信任域
win.webContents.on('will-navigate', (event, url) => {
  if (!url.startsWith('https://im.coclaw.net')) {
    event.preventDefault();
  }
});

// 阻止新窗口打开（外部链接走 shell.openExternal）
win.webContents.setWindowOpenHandler(({ url }) => {
  shell.openExternal(url);
  return { action: 'deny' };
});
```

### 5.4 权限自动授予范围

| 权限类型 | 说明 | 授予条件 |
|---|---|---|
| `media` | 麦克风 + 摄像头 | `*.coclaw.net` |
| `notifications` | 系统通知 | `*.coclaw.net` |
| `clipboard-read` | 剪贴板读取 | `*.coclaw.net` |
| `clipboard-sanitized-write` | 剪贴板写入 | `*.coclaw.net` |
| `fullscreen` | 全屏 | `*.coclaw.net` |
| `display-capture` | 屏幕录制/截图 | `*.coclaw.net` |
| 其他域 | 一律拒绝 | — |

## 6. 系统托盘

### 6.1 功能设计

与 Tauri 方案一致：

| 行为 | 默认 | 用户可配置 |
|---|---|---|
| 关闭窗口时 | 最小化到托盘 | 设置页切换为"直接退出" |
| 托盘图标左键单击 | 显示/隐藏主窗口 | — |
| 托盘右键菜单 | 显示窗口 / 退出 | — |

### 6.2 托盘菜单

```
CoClaw（tooltip）
├── 显示窗口
├── ─────────
└── 退出
```

### 6.3 壳子设置 UX

所有壳子设置放在 Web 设置页面（仅 Electron 环境显示），不设独立原生面板。通过 `window.electronAPI.getSetting` / `setSetting` 读写。

### 6.4 托盘图标规格

| 平台 | 格式 | 尺寸 | 备注 |
|---|---|---|---|
| Windows | ICO 或 PNG | 16×16 px | |
| macOS | PNG (template) | 16×16 + 32×32@2x | 文件名含 `Template`，自动适配深/浅色 |

## 7. IM 通知与注意力机制

所有行为由 **Web 端驱动**，通过 `window.electronAPI` 调用。

### 7.1 三层提醒机制

| 层级 | 机制 | Windows API | macOS API |
|---|---|---|---|
| 1 | 系统通知 | `new Notification()` + Action Center | `new Notification()` + 通知中心 |
| 2 | 任务栏/Dock 闪烁 | `win.flashFrame(true)` | `app.dock.bounce('informational')` |
| 3 | 托盘图标闪动 | setInterval + `tray.setImage()` | 同左 |

### 7.2 应用图标未读数字徽章

**全部为 Electron 内置 JS API，无需任何原生代码**：

| 平台 | API | 效果 |
|---|---|---|
| Windows | `win.setOverlayIcon(image, desc)` | 任务栏按钮右下角 16×16 图标 |
| macOS | `app.setBadgeCount(count)` 或 `app.dock.setBadge(string)` | Dock 图标红色数字圆圈 |

Windows 叠加图标需 Web 端渲染数字为图片（Canvas → dataURL → 传给主进程）：

```js
// Web 端
function renderBadgeIcon(count) {
  const canvas = document.createElement('canvas');
  canvas.width = 16; canvas.height = 16;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#FF3B30';
  ctx.beginPath(); ctx.arc(8, 8, 8, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#FFF';
  ctx.font = 'bold 11px sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(count > 99 ? '99+' : String(count), 8, 9);
  return canvas.toDataURL();
}

// 调用
window.electronAPI.setOverlayIcon(renderBadgeIcon(5), '5 unread messages');
// 清除
window.electronAPI.clearOverlayIcon();
```

### 7.3 与 Tauri 方案的对比

| 特性 | Tauri | Electron |
|---|---|---|
| 任务栏叠加图标 | 需 Rust command（JS API 不支持） | `win.setOverlayIcon()` — 纯 JS |
| Dock 徽章 | 需 Rust command | `app.setBadgeCount()` — 纯 JS |
| 任务栏闪烁 | `requestUserAttention` (有 bug) | `win.flashFrame()` — 稳定 |
| Dock 弹跳 | `requestUserAttention` | `app.dock.bounce()` — 纯 JS |
| 托盘图标切换 | `tray.setIcon()` | `tray.setImage()` — 同等能力 |

## 8. 屏幕截图（桌面端独有能力）

桌面端独有的重要能力，需一次性预埋到壳子中。

### 8.1 能力概述

| 能力 | Windows | macOS | Web 浏览器 |
|---|---|---|---|
| 全屏截图 | ✅ 无需权限 | ✅ 需 Screen Recording 权限 | ❌ 需用户主动分享 |
| 区域截图 | ✅ | ✅ | ❌ |
| 全局快捷键触发 | ✅ | ✅ | ❌ |
| 窗口选择截图 | ✅ | ✅ | ❌ |

### 8.2 技术方案

**核心 API**：
- `desktopCapturer.getSources()`（主进程，Electron 17+ 仅限主进程）— 获取可捕获的屏幕/窗口列表
- `session.setDisplayMediaRequestHandler()` — 拦截 `getDisplayMedia()` 调用，实现静默捕获
- `globalShortcut.register()` — 注册全局快捷键（即使应用在后台也可触发）

**截图流程**：

```
用户按下全局快捷键（如 Ctrl+Shift+A / Cmd+Shift+A）
  │
  ├─ 主进程捕获全屏截图（desktopCapturer → getUserMedia → canvas）
  │
  ├─ 创建透明全屏覆盖窗口（transparent + frameless + alwaysOnTop）
  │  └─ 显示全屏截图（略微变暗）作为背景
  │  └─ 用户拖拽选择截图区域
  │  └─ 用户确认：裁剪选区 → 返回图片数据
  │  └─ 用户取消：关闭覆盖窗口
  │
  ├─ 截图数据通过 IPC 传回主窗口渲染进程
  │
  └─ Web 端接收截图，插入聊天输入区
```

### 8.3 主进程实现要点

```js
// ipc-handlers.js 中新增

const { desktopCapturer, systemPreferences } = require('electron');

// 获取可用屏幕/窗口源
ipcMain.handle('screenshot:getSources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 1920, height: 1080 },
  });
  return sources.map(s => ({
    id: s.id,
    name: s.name,
    thumbnail: s.thumbnail.toDataURL(),
  }));
});

// macOS 权限检查
ipcMain.handle('screenshot:checkPermission', () => {
  if (process.platform === 'darwin') {
    return systemPreferences.getMediaAccessStatus('screen');
    // 'not-determined' | 'granted' | 'denied' | 'restricted'
  }
  return 'granted'; // Windows 始终可用
});

// 全局快捷键注册
const { globalShortcut } = require('electron');
const accelerator = process.platform === 'darwin'
  ? 'Command+Shift+A'
  : 'Ctrl+Shift+A';
globalShortcut.register(accelerator, () => {
  win.webContents.send('screenshot-trigger');
});
```

### 8.4 区域选择覆盖窗口

截图区域选择通过一个临时的透明全屏窗口实现：

```js
// 主进程
function openScreenshotOverlay(screenshotDataUrl) {
  const { screen } = require('electron');
  const display = screen.getPrimaryDisplay();

  const overlay = new BrowserWindow({
    x: 0,
    y: 0,
    width: display.size.width,
    height: display.size.height,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    fullscreen: true,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload-screenshot.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });

  overlay.loadFile('screenshot-overlay.html');
  // 传入截图数据，overlay 页面用 canvas 实现拖拽选区
  overlay.webContents.once('did-finish-load', () => {
    overlay.webContents.send('screenshot-data', screenshotDataUrl);
  });
}
```

**实现细节**：
- `screenshot-overlay.html` 是一个本地页面（打包在壳子中），使用 Canvas 绘制截图背景 + 半透明蒙层 + 拖拽选区
- 选区确认后，裁剪 canvas 并通过 IPC 将图片数据传回主窗口
- 可考虑使用 `electron-screenshots`（nashaofu）作为成熟方案，它还支持标注工具（画笔、文字、马赛克、箭头等）

### 8.5 全局快捷键

| 平台 | 默认快捷键 | 说明 |
|---|---|---|
| Windows | `Ctrl+Shift+A` | 避开系统截图键 `Win+Shift+S` |
| macOS | `Cmd+Shift+A` | 避开系统截图键 `Cmd+Shift+4` |

- 通过 `globalShortcut.register()` 注册，即使应用在后台也可触发
- 若快捷键已被其他应用占用，`register()` 返回 `false`，需 fallback 或允许用户自定义
- 快捷键自定义可纳入壳子设置（通过 `electron-store` 持久化，Web 设置页配置）
- 在 `app.on('will-quit')` 中调用 `globalShortcut.unregisterAll()` 清理

### 8.6 macOS 权限处理

macOS 10.14+ 通过 TCC 系统管理屏幕录制权限：

1. **首次调用 `desktopCapturer.getSources()`** 时系统自动弹出授权对话框
2. 用户需在"系统设置 > 隐私与安全性 > 屏幕录制"中允许 CoClaw
3. 授权后 `systemPreferences.getMediaAccessStatus('screen')` 返回 `'granted'`
4. 若用户拒绝，Web 端应显示引导提示，指引用户前往系统设置手动授权
5. **已知问题**：`getMediaAccessStatus('screen')` 在用户在系统设置中切换权限后可能不立即反映变化，需重启应用

**Info.plist**（已在 electron-builder 配置中通过 `extendInfo` 注入）：
```xml
<key>NSScreenCaptureUsageDescription</key>
<string>CoClaw 需要屏幕录制权限来支持截图功能</string>
```

**MAS entitlements**（已在 `entitlements.mas.plist` 中声明）：
```xml
<key>com.apple.security.screen-capture</key><true/>
```

### 8.7 第三方库评估

| 库 | 功能 | 维护状态 | 推荐度 |
|---|---|---|---|
| `electron-screenshots` (nashaofu) | 完整截图 UX（选区 + 标注工具） | 活跃度一般 | 高（功能最全） |
| `node-screenshots` (nashaofu) | 底层原生截图（napi-rs/Rust） | 活跃 | 中（需自建选区 UI） |
| `electron-region-screenshot` | 区域选择，返回 base64 | 较新 | 中 |
| 自研（desktopCapturer + overlay） | 完全可控 | — | 长期最佳 |

**建议**：初期使用 `electron-screenshots` 快速实现完整功能（含标注），后续按需替换为自研方案。

### 8.8 与 Tauri 方案的对比

Tauri v2 不提供 `desktopCapturer` 等效 API。WebView2 的 `getDisplayMedia()` 可用但无法静默捕获（需用户交互选择共享内容），且无法注册全局快捷键触发。WKWebView 更受限。

**屏幕截图是 Electron 相对 Tauri 的又一个显著优势**，且这个能力正是桌面 IM 的核心差异化特性。

## 9. 平台检测与前端适配

### 9.1 统一平台检测

已有 `src/utils/platform.js`，Electron 检测方式：

```js
/** 是否运行在 Electron 壳子中 */
export const isElectronApp = !!window.electronAPI;

/** 是否运行在移动壳子（Capacitor）中 */
export const isCapacitorApp = !!window.Capacitor?.isNativePlatform();

/** 是否运行在任何原生壳子中 */
export const isNativeShell = isCapacitorApp || isElectronApp;
```

### 9.2 `isNative` 迁移

与 Tauri 方案相同：现有 `isNative` 引用改为 `isCapacitorApp`（仅移动壳子需要的适配）。Electron 桌面端行为与 Web 浏览器一致，不需要这些移动端适配。

### 9.3 Electron 壳子初始化

```js
// src/utils/electron-app.js
import { isElectronApp } from './platform.js';

export function initElectronApp(router) {
  if (!isElectronApp) return;

  // Deep Link 监听
  window.electronAPI.onDeepLink((url) => {
    // coclaw://chat/xxx → /chat/xxx
    const parsed = new URL(url);
    router.push(parsed.host + parsed.pathname);
  });

  // 窗口获焦时通知 Web 端（可用于停止闪动/更新徽章）
  window.electronAPI.onWindowFocus(() => {
    // 由各 store 处理
  });
}
```

## 10. 构建与分发

### 10.1 electron-builder.yml

```yaml
appId: net.coclaw.im
productName: CoClaw
copyright: "Copyright 2026 Chengdu Gongyan Technology Co., Ltd."

directories:
  output: dist-electron
  buildResources: build-resources

# 不打包前端代码（远程加载）
files:
  - electron/**/*
  - build-resources/tray-icon*.png
  - package.json

asar: true

publish:
  provider: github
  owner: AYuaner
  repo: coclaw
  releaseType: release

# ---- Windows ----
win:
  target:
    - target: nsis
  icon: build-resources/icon.ico
  appx:
    publisher: "CN=xxxxx"  # 从 Partner Center 获取
    identityName: "xxxxx"
    publisherDisplayName: "Chengdu Gongyan Technology Co., Ltd."

nsis:
  oneClick: false
  perMachine: false
  allowElevation: true
  createDesktopShortcut: true
  shortcutName: CoClaw
  installerLanguages:
    - zh_CN
    - en_US

# ---- macOS ----
mac:
  target:
    - target: dmg
      arch: [universal]
    - target: mas
      arch: [universal]
  icon: build-resources/icon.icns
  category: public.app-category.social-networking
  darkModeSupport: true
  minimumSystemVersion: "12.0"
  hardenedRuntime: true
  entitlements: build-resources/entitlements.mac.plist
  entitlementsInherit: build-resources/entitlements.mac.inherit.plist
  extendInfo:
    NSMicrophoneUsageDescription: "CoClaw 需要使用麦克风来录制语音消息"
    NSCameraUsageDescription: "CoClaw 需要使用摄像头来拍摄照片和视频"
    NSScreenCaptureUsageDescription: "CoClaw 需要屏幕录制权限来支持截图功能"

mas:
  hardenedRuntime: false
  entitlements: build-resources/entitlements.mas.plist
  entitlementsInherit: build-resources/entitlements.mas.inherit.plist

dmg:
  window:
    width: 540
    height: 380
```

### 10.2 macOS 权限文件

**`entitlements.mas.plist`**（Mac App Store）：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.app-sandbox</key><true/>
    <key>com.apple.security.cs.allow-jit</key><true/>
    <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
    <key>com.apple.security.cs.disable-library-validation</key><true/>
    <key>com.apple.security.network.client</key><true/>
    <key>com.apple.security.device.audio-input</key><true/>
    <key>com.apple.security.device.camera</key><true/>
    <key>com.apple.security.files.user-selected.read-write</key><true/>
    <key>com.apple.security.files.downloads.read-write</key><true/>
    <!-- 屏幕截图 -->
    <key>com.apple.security.screen-capture</key><true/>
</dict>
</plist>
```

**`entitlements.mas.inherit.plist`**（子进程）：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.app-sandbox</key><true/>
    <key>com.apple.security.inherit</key><true/>
</dict>
</plist>
```

**`entitlements.mac.plist`**（直接下载版，需 Hardened Runtime）：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.cs.allow-jit</key><true/>
    <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
    <key>com.apple.security.cs.disable-library-validation</key><true/>
    <key>com.apple.security.device.audio-input</key><true/>
    <key>com.apple.security.device.camera</key><true/>
</dict>
</plist>
```

> **屏幕截图权限说明**：macOS 的 Screen Recording 权限（`kTCCServiceScreenCapture`）由系统 TCC 框架管理。首次调用 `desktopCapturer.getSources()` 时系统自动弹窗请求授权，无法通过代码触发。若用户拒绝，需手动前往"系统设置 > 隐私与安全性 > 屏幕录制"中授权。Windows 无此限制，始终可用。

### 10.3 构建命令

```bash
# Windows NSIS（可在 Linux/WSL2 上执行，需 Wine）
pnpm electron:build --win nsis

# Windows AppX（仅 Windows 上执行）
pnpm electron:build --win appx

# macOS DMG（仅 macOS 上执行）
pnpm electron:build --mac dmg

# macOS App Store（仅 macOS 上执行）
pnpm electron:build --mac mas
```

### 10.4 交叉编译能力

| 构建目标 | 从 Linux/WSL2 | 从 Windows | 从 macOS |
|---|---|---|---|
| Windows NSIS | ✅（需 Wine） | ✅ | ✅ |
| Windows AppX | ❌ | ✅ | ❌ |
| macOS DMG | ❌（无法签名） | ❌ | ✅ |
| macOS MAS | ❌ | ❌ | ✅ |

**关键优势**：日常 Windows NSIS 构建可直接在 WSL2 中完成，无需切换到 Windows 宿主机。

### 10.5 安装包输出

| 平台 | 格式 | 用途 | 大致体积 |
|---|---|---|---|
| Windows | `CoClaw-Setup-{version}.exe` (NSIS) | 官网直接下载 | ~80-100 MB |
| Windows | `.appx` | Microsoft Store | ~80-100 MB |
| macOS | `CoClaw-{version}-universal.dmg` | 官网直接下载 | ~120-150 MB |
| macOS | `.pkg` (MAS) | Mac App Store | ~120-150 MB |

### 10.6 代码签名策略

| 平台 | 分发渠道 | 签名方式 |
|---|---|---|
| Windows | Microsoft Store (AppX) | 商店自动签名 |
| Windows | 官网直接下载 (NSIS) | OV 证书（初期） |
| macOS | Mac App Store | Apple Distribution 证书 |
| macOS | 官网直接下载 (DMG) | Developer ID Application + Notarization |

### 10.7 自动更新

使用 `electron-updater`，配合 GitHub Releases：

```
用户端                                    GitHub Releases
  │                                           │
  ├─ checkForUpdates()  ──────────────────► │
  │  GET /latest.yml                          │
  │                                           │
  ◄─────────────── 有更新（version, url）─────┤
  │                                           │
  ├─ downloadUpdate() ───────────────────► │
  │  进度回调                                  │
  │                                           │
  ├─ quitAndInstall() ──► 重启应用            │
```

electron-builder 构建时自动生成 `latest.yml`（Windows）/ `latest-mac.yml`（macOS）清单文件，随安装包一起发布到 GitHub Releases。

## 11. package.json 变更

```jsonc
{
  "main": "electron/main.js",
  "devDependencies": {
    "electron": "^41",
    "electron-builder": "^26"
  },
  "dependencies": {
    "electron-store": "^10",
    "electron-updater": "^6",
    "electron-window-state": "^5",
    "electron-log": "^5"
  },
  "scripts": {
    "electron:dev": "electron .",
    "electron:build": "electron-builder",
    "electron:build:win": "electron-builder --win nsis",
    "electron:build:mac": "electron-builder --mac dmg",
    "electron:build:mas": "electron-builder --mac mas"
  }
}
```

> **注**：`electron-store` v10+ 是 ESM-only。若主进程使用 CommonJS（`require`），需使用 v8.x 或将主进程改为 ESM。建议主进程保持 CommonJS，使用 `electron-store@8`。

## 12. 已知风险与缓解

### 12.1 安装包体积

**风险**：Electron 打包 Chromium，安装包 ~100 MB，远大于 Tauri 的 ~5 MB
**缓解**：
1. 远程加载模式下不打包前端资源，已是最小体积
2. electron-builder 支持 NSIS-web（仅下载器，安装时在线获取主体），可考虑
3. 桌面用户对 100 MB 安装包接受度远高于移动端
4. Microsoft Store / Mac App Store 自行管理分发和增量更新

### 12.2 macOS App Store 沙箱

**风险**：MAS 强制 App Sandbox，已知存在 Electron 兼容性问题（子进程签名、JIT 权限等）
**缓解**：
1. 提供完整的 entitlements 文件（含 `allow-jit`、`disable-library-validation`）
2. 使用 MAS 专用 Electron 构建（`mas-` 前缀）
3. 构建后用 Apple WACK 工具本地验证
4. 若 MAS 审核受阻，优先通过官网 DMG + Notarization 分发

### 12.3 Windows SmartScreen 警告

与 Tauri 方案相同。OV 证书初期有"未知发布者"警告，引导用户优先从 Microsoft Store 安装。

### 12.4 electron-store ESM 兼容性

**风险**：`electron-store` v10+ 为 ESM-only，与 CommonJS 主进程不兼容
**缓解**：使用 `electron-store@8`（最后一个 CommonJS 版本），或将主进程改为 ESM

### 12.5 Electron 大版本升级

**风险**：Electron 约每 8 周一个大版本，可能引入破坏性变更
**缓解**：
1. 壳子功能简单（远程加载 + 托盘 + IPC），受破坏性变更影响小
2. 锁定 Electron 大版本（如 `^41`），仅在必要时升级
3. 壳子目标是"少升级"，Chromium 安全更新由 Electron minor/patch 版本覆盖

## 13. 实施计划

### Phase 1：Electron 壳子开发

1. **项目初始化**
   - 创建 `electron/` 目录结构
   - 安装依赖（`electron`, `electron-builder`, `electron-store`, `electron-updater`, `electron-window-state`）
   - 配置 `electron-builder.yml`
   - 准备图标资源

2. **核心功能实现**
   - `main.js`：窗口创建、远程加载、安全配置
   - `preload.js`：`contextBridge` 全部 API 暴露（含截图、徽章、托盘等）
   - `permissions.js`：权限自动授予（media、notifications、display-capture）
   - `tray.js`：系统托盘、最小化到托盘、图标闪动
   - `ipc-handlers.js`：对话框、剪贴板、通知、徽章、截图源获取
   - `deep-link.js`：`coclaw://` 协议注册 + 单实例锁
   - `updater.js`：自动更新
   - 屏幕截图：`desktopCapturer` + 全局快捷键 + 区域选择覆盖窗口
   - 全局快捷键注册（截图 Ctrl/Cmd+Shift+A）

3. **前端适配**
   - 更新 `src/utils/platform.js`（`isElectronApp` 替代 `isTauriApp`）
   - 更新 `src/utils/electron-app.js`（替代 `tauri-app.js`）
   - 确保 `isNative` 迁移仍正确

4. **构建验证**
   - WSL2 构建 Windows NSIS 安装包（Wine）
   - 安装并测试：远程加载、托盘、语音录制、剪贴板、通知、徽章、截图（全局快捷键 + 区域选择）

### Phase 2：Microsoft Store 上架

1. 注册公司开发者账号（$99）
2. Windows 宿主机构建 AppX
3. 准备商店素材
4. 提交审核

### Phase 3：macOS 壳子验证与上架

1. macOS 环境搭建
2. 测试 DMG 构建 + Notarization
3. 测试 MAS 构建（App Sandbox）
4. Apple Developer 组织账号
5. Mac App Store 上架

### Phase 4：CI/CD

- GitHub Actions：Windows runner + macOS runner
- 自动构建 + 发布到 GitHub Releases
- 自动生成 `latest.yml` 更新清单

## 14. 商店上架前置清单

- [ ] 隐私政策页面（三端共用同一 URL）
- [ ] 用户服务协议页面（三端共用同一 URL）
- [ ] 应用截图：Windows、macOS 各一套
- [ ] 应用简介：中/英文
- [ ] 年龄分级：IARC (Microsoft) / Apple 问卷
- [ ] Microsoft Store 公司开发者账号（$99 一次性）
- [ ] Apple Developer 组织账号（$99/年，需 D-U-N-S）
- [ ] Windows OV 代码签名证书（官网下载版）
- [ ] macOS Developer ID + Apple Distribution 证书
- [ ] Android 图标徽章：补充 `@capawesome/capacitor-badge` 到 APK 壳子
