# Relaydeck

Relaydeck 让两台设备连接同一个 Chrome Profile，并分别控制不同页面。所有客户端共享页面列表和认证状态；页面按工作分组分配控制权，其他客户端可以实时观看或接管整个分组。

## 工作方式

- 一个专用 Chrome 进程保存登录状态。
- 本地网关通过 Chrome DevTools Protocol 连接页面目标。
- 每个控制端绑定自己的 `targetId`，画面通过 CDP screencast 推送。
- 初始标签页和它打开的子标签页自动归入同一分组，并继承该分组的控制权。
- 鼠标和键盘事件只发送到当前页面会话，不依赖桌面全局焦点。
- Cookie、Local Storage 和认证令牌不会发送给控制端。

## 快速启动

要求 Node.js 22.13+ 和 Google Chrome/Chromium。

```bash
npm install
npm run dev
```

`npm run dev` 会打印一次性访问令牌，并启动：

- 控制台：`http://127.0.0.1:3000`
- 网关：`ws://127.0.0.1:8788`

另开一个终端启动专用 Chrome：

```bash
npm run chrome
```

常驻服务器建议先构建，再启动生产模式：

```bash
npm run build
npm start
```

也可以复制 `.env.example` 为 `.env.local`，设置固定令牌并自动启动 Chrome：

```dotenv
GATEWAY_TOKEN=replace-with-a-long-random-token
AUTO_START_CHROME=1
```

然后在两台设备的控制台中填写相同网关地址和令牌。远程设备建议通过 Tailscale 访问服务器私网地址；不要公开 Chrome 的 `9222` 端口。

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
| `GATEWAY_TOKEN` | 自动生成 | 控制端访问令牌，固定配置时至少 12 字符 |
| `GATEWAY_HOST` | `127.0.0.1` | 网关监听地址 |
| `GATEWAY_PORT` | `8788` | 网关 WebSocket 端口 |
| `CDP_HTTP_URL` | `http://127.0.0.1:9222` | Chrome 调试发现地址 |
| `CHROME_PROFILE_DIR` | `data/chrome-profile` | 专用 Chrome Profile |
| `DEFAULT_URL` | `https://ac.nowcoder.com/` | 新页面默认地址 |
| `AUTO_START_CHROME` | `0` | 是否随本地服务启动 Chrome |

如果需要让第二台设备通过 Tailscale 访问，将 `UI_HOST` 和
`GATEWAY_HOST` 都设置为服务器的 Tailscale IP，而不是 `0.0.0.0`，并使用足够长的随机令牌：

```dotenv
UI_HOST=100.x.y.z
GATEWAY_HOST=100.x.y.z
GATEWAY_TOKEN=replace-with-a-long-random-token
```

## 当前限制

- 页面画面不包含 Chrome 地址栏、扩展弹窗和系统文件选择器。
- 中文输入法组合事件尚未转发；普通键盘输入、快捷键、鼠标和滚轮可用。
- 同一分组不支持两个设备同时写入，采用显式接管以避免输入互相干扰。
- DevTools Protocol 拥有完整浏览器权限，`9222` 必须仅监听 `127.0.0.1`。
