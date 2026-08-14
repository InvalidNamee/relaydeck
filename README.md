# Relaydeck

Relaydeck 是一个前后端分离的局域网共享浏览器：Node.js 网关控制服务器上的独立
Chrome Profile，Windows/macOS Tauri 客户端只接收画面和发送输入。所有客户端共享页面
列表和认证状态；页面按工作分组分配控制权，其他客户端可以实时观看或接管整个分组。

## 工作方式

- 一个专用 Chrome 进程保存登录状态。
- 本地网关通过 Chrome DevTools Protocol 连接页面目标。
- 每个控制端绑定自己的 `targetId`，画面通过 CDP screencast 推送。
- 初始标签页和它打开的子标签页自动归入同一分组，并继承该分组的控制权。
- 当前控制端会把远端页面视口强制同步为前端画布的可用尺寸。
- 工具栏支持双向纯文本剪贴板，也可在远端画面聚焦时使用 `Ctrl/Cmd+C` 和 `Ctrl/Cmd+V`。
- 鼠标和键盘事件只发送到当前页面会话，不依赖桌面全局焦点。
- 网站 Cookie 和 Local Storage 不会发送给控制端；客户端只保存网关访问令牌。

## 项目结构

```text
apps/gateway       独立 Node.js/CDP 网关
apps/client        React + Vite 客户端
apps/desktop       Tauri 2 桌面壳
packages/protocol  共享协议、校验和二进制画面格式
packages/client-core  WebSocket 认证、重连和状态机
packages/client-ui    Windows/macOS/Web 共用界面
```

## 开发启动

要求 Node.js 22.13+ 和 Google Chrome/Chromium。

```bash
npm install
npm run dev
```

`npm run dev` 会打印一次性访问令牌，并启动：

- 调试客户端：`http://127.0.0.1:1420`
- 网关：`ws://0.0.0.0:8788`

默认开发配置不会自动启动 Chrome。可复制环境文件并启用：

```bash
cp .env.example .env.local
```

```dotenv
GATEWAY_TOKEN=replace-with-at-least-32-random-characters
AUTO_START_CHROME=1
CHROME_HEADLESS=0
```

桌面客户端开发和生产构建：

```bash
npm run desktop:dev
npm run desktop:build
```

正式局域网部署、Windows/macOS 安装包和防火墙配置见
[生产部署文档](docs/PRODUCTION.md)。不要向局域网或公网开放 Chrome 的 `9222` 端口。

## 分组与独立操作

1. 在“共享窗口”的选择器中切换分组，使用 `G+` 创建分组、`G−` 删除当前分组。
2. `＋` 会在当前标签下方新建页面；该页面产生的弹窗或新标签页自动排在父页面下方、加入同组，并默认切换跟踪新页面。
3. 控制权以分组为单位继承：取得一个分组后，可以操作组内全部标签页。
4. 两台设备分别控制不同分组时，可以同时独立操作；同一分组的其他设备保持只读或主动接管。
5. 标签页右侧的 `×` 可以关闭该页；删除分组不会关闭页面，剩余页面会迁入默认工作区。
6. 关闭或断开设备时，它持有的分组会自动释放。

## 配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `GATEWAY_TOKEN` | 必填 | 控制端访问令牌，至少 32 字符 |
| `GATEWAY_HOST` | `0.0.0.0` | 网关监听地址 |
| `GATEWAY_PORT` | `8788` | 网关 WebSocket 端口 |
| `CDP_HTTP_URL` | `http://127.0.0.1:9222` | Chrome 调试发现地址 |
| `CHROME_PROFILE_DIR` | `data/chrome-profile` | 专用 Chrome Profile |
| `DEFAULT_URL` | `https://ac.nowcoder.com/` | 新页面默认地址 |
| `AUTO_START_CHROME` | `0` | 是否随本地服务启动 Chrome |
| `CHROME_HEADLESS` | Linux 为 `1`，其他系统为 `0` | 是否以无界面模式启动 Chrome；Linux 没有 `$DISPLAY`/`$WAYLAND_DISPLAY` 时会自动强制为 `1` |
| `RELAYDECK_DATA_DIR` | `data` | 工作区状态和默认 Profile 根目录 |
| `GATEWAY_ALLOWED_ORIGINS` | 空 | 可选的逗号分隔 Origin 白名单 |

客户端连接服务器的固定局域网地址：

```text
ws://192.168.1.20:8788
```

网关使用首包认证，令牌不会进入 URL。桌面端可以保存多个网关，令牌由 macOS Keychain
或 Windows Credential Manager 管理。画面使用二进制 WebSocket 帧；控制消息使用经过校验的
版本化 JSON 协议。

## 当前限制

- 页面画面不包含 Chrome 地址栏、扩展弹窗和系统文件选择器。
- 中文输入法组合事件通过 `Input.insertText` 转发；部分候选窗口仍由本机系统显示。
- 双向剪贴板当前支持纯文本，不包含图片、文件或富文本格式；浏览器可能首次请求剪贴板权限。
- 同一分组不支持两个设备同时写入，采用显式接管以避免输入互相干扰。
- DevTools Protocol 拥有完整浏览器权限，`9222` 必须仅监听 `127.0.0.1`。
- `ws://` 不提供传输加密，只应用于可信家庭/办公局域网；非可信网络请使用 Tailscale 或 TLS。
