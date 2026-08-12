# Relaydeck 生产部署

Relaydeck 由两个独立部分组成：

- 网关运行在保存 Chrome Profile 的主机上，需要 Node.js 22.13+ 和 Chrome/Chromium。
- Tauri 客户端安装在 Windows 或 macOS 设备上，只通过局域网连接网关。

## 网关主机

```bash
npm ci --omit=dev --ignore-scripts
cp deploy/gateway.env.example .env.local
```

为 `GATEWAY_TOKEN` 生成至少 32 个随机字符，例如：

```bash
openssl rand -base64 32
```

修改 `.env.local` 后运行：

```bash
npm run gateway
```

默认配置会：

- 在 `0.0.0.0:8788` 接收局域网 WebSocket 连接；
- 自动启动带独立 Profile 的 Chrome；
- 让 Chrome DevTools 端口只监听 `127.0.0.1:9222`；
- 将工作区和 Chrome Profile 写入 `data/`。

如果 Chrome 已由其他进程管理，将 `AUTO_START_CHROME=0`，并确保它使用以下参数：

```text
--remote-debugging-address=127.0.0.1
--remote-debugging-port=9222
--user-data-dir=<独立目录>
```

Linux 常驻部署可以参照 `deploy/relaydeck-gateway.service`。将项目放在
`/opt/relaydeck`，配置写入 `/etc/relaydeck/gateway.env`，可写数据目录设为
`/var/lib/relaydeck`。

## 局域网安全

必须满足：

1. 路由器不配置 `8788` 端口转发、DMZ 或 UPnP 映射。
2. 不向局域网开放 `9222`；使用 `ss`、`lsof` 或 `netstat` 确认它只在
   `127.0.0.1` 监听。
3. 服务主机使用固定局域网地址或 DHCP 保留地址。
4. 家庭/可信局域网可使用 `ws://<局域网IP>:8788`；公共、宿舍或访客网络应改用
   Tailscale 或反向代理 TLS。
5. 网关令牌不能复用网站密码；泄露后立即更换并重启网关。

Windows 网关主机可在管理员 PowerShell 中运行：

```powershell
Set-NetConnectionProfile -NetworkCategory Private
.\deploy\windows-firewall.ps1
```

该脚本仅允许专用网络的本地子网访问 TCP 8788。

## 客户端安装

CI 会分别生成：

- `relaydeck-windows-x64`：NSIS `.exe` 和 MSI 安装包；
- `relaydeck-macos-arm64`：`.app` 和 `.dmg`。

安装后新增网关配置，填写：

```text
连接名称：家里主机
设备名称：我的 MacBook
网关地址：ws://192.168.1.20:8788
访问令牌：与网关配置一致
```

客户端可保存多个网关。普通配置存储在 WebView 本地数据中；令牌分别存入 macOS
Keychain 或 Windows Credential Manager。删除连接配置时，对应的系统凭据也会删除。

未签名测试构建在 Windows SmartScreen 或 macOS Gatekeeper 中会出现发行者警告。正式分发
需要在 CI 注入 Apple Developer ID 和 Windows 代码签名证书；证书不得提交进仓库。

## 发布前检查

```bash
npm ci --ignore-scripts
npm run lint
npm test
npm audit --omit=dev --audit-level=high
cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml
npm run desktop:build
```

随后至少用一台 Windows 和一台 macOS 设备完成：连接、保存/删除多个网关、中文输入、
复制粘贴、标签页切换、分组接管、网关重启后的自动重连，以及两台客户端同时控制不同分组。
