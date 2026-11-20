# VPS / Node 部署指南

VPS/Node 与 Cloudflare 部署共用同一套前端、加密协议与业务核心，差异仅在于入口、存储适配与运行参数。本文介绍如何在 Linux 服务器上部署云端中继与静态 Web 入口。

云端服务仅负责托管前端页面、账号/加密消息接口（`/api/im/*`）和 Noise 密文中继（`/connect`）；用户的电脑通过纯 Rust 桌面适配器主动向云端建立出站 WSS 连接，云端不需要能够反连电脑，也无需在电脑端开放公网端口。

## 环境要求

- Linux 服务器，已安装 **Node.js 24+**
- 已配置 HTTPS 证书的反向代理（如 Caddy 或 Nginx）
- 一个可用的 HTTPS 域名（例如 `https://app.example.com`）

## 1. 构建服务端与前端

```bash
git clone https://github.com/muxkin/fable-pavilion.git
cd fable-pavilion
npm ci
POCKET_ENV_FILE=/dev/null npm run build:server
POCKET_ENV_FILE=/dev/null npm run build:web
```

- 静态网页产物位于 `dist/web`，云端服务入口位于 `dist/server/relay-main.js`。
- 静态资源默认同源托管，无需额外 CDN。若启用 CDN，构建与运行时的 `POCKET_ASSET_BASE` 必须完全一致，且应先发布带哈希的静态资源，再切换 HTML；`/version.json`、`/release.json` 与 HTML 必须禁用长期缓存。

## 2. 配置服务端环境变量

在服务器私有目录（权限 `0600`）创建环境文件，切勿将其提交到仓库或与电脑端环境文件混用。完整配置说明参见 [.env.example](../../.env.example)。

```dotenv
# 必填：对外访问的精确 HTTPS origin（不含路径和末尾斜杠）
POCKET_PUBLIC_ORIGIN=https://app.example.com

# 必填：主机接入注册密钥（至少 32 字节随机值，不要暴露给浏览器）
POCKET_RELAY_ENROLLMENT=<随机生成的32字节以上密钥>

# 必填：账号 TOTP 种子加密密钥（32 字节随机 base64url，请独立备份）
POCKET_IM_TOTP_KEY=<使用下方命令生成>

# 监听地址与状态目录
POCKET_RELAY_BIND=127.0.0.1
POCKET_RELAY_PORT=4318
POCKET_RELAY_STATE=/var/lib/fable-pavilion
POCKET_WEB_ROOT=/opt/fable-pavilion/current/dist/web

# 反向代理在本机回环时仅信任回环地址；直连公网时留空
POCKET_RELAY_TRUSTED_PROXIES=127.0.0.1,::1
```

生成 `POCKET_IM_TOTP_KEY`（32 字节无填充 base64url）：

```bash
node -p "require('node:crypto').randomBytes(32).toString('base64url')"
```

> **重要**：缺少 `POCKET_IM_TOTP_KEY` 时，新账号注册与新密码登录会被拒绝，系统不会降级为仅密码登录。迁移同一账号数据库时必须保留原密钥，新建独立实例时应重新生成。

### 常用可选配置

| 变量 | 说明 |
| --- | --- |
| `POCKET_IM_REGISTRATION_ENABLED` | 设为 `false` 关闭个人自助注册（默认 `true`）；已有账户与 Agent 邀请不受影响。 |
| `POCKET_IM_REGISTRATION_CODE` | 开放注册时要求填写的注册邀请码；留空表示允许自由注册。 |
| `POCKET_IM_HUMAN_CONTACTS` | 设为 `true` 启用人与人之间的好友与社交聊天（默认 `false`，仅允许用户与自己的 Agent 通信）。 |
| `POCKET_ASSET_BASE` | 可选公开静态资源 CDN 前缀，必须与前端构建参数一致。 |
| `POCKET_LOGIN_ARTWORK_BASE` | 可选仅用于登录页插画的 HTTPS CDN 父目录。 |
| `POCKET_LOGIN_REDIRECT_ORIGINS` | 可选，逗号分隔的精确 HTTPS origin 列表（构建期参数），用于允许跨关联域名扫码登录时展示跳转链接。 |
| `POCKET_SUPPORT_CONFIG` / `POCKET_SUPPORT_QR_FILE` | 可选，构建期注入私有赞赏配置与二维码图片，见 [支持项目页面配置](donations.md)。 |
| `POCKET_ANDROID_DOWNLOADS_DIR` | 可选，构建期注入包含 Android `latest.json` 与签名 APK 的私有目录。 |
| `POCKET_UPLOAD_ORIGINS` | 启用外部私有对象存储直传时，以逗号分隔的精确 HTTPS origin 白名单。 |
| `POCKET_TRANSLATION_URL` / `POCKET_TRANSLATION_API_KEY` | 可选的 LibreTranslate 接口地址与密钥，启用站内划词翻译（不向数据库保存原文或译文）。 |
| `POCKET_DESKTOP_RELEASE_ROOT` / `POCKET_DESKTOP_DOWNLOAD_BASE` | 自托管桌面安装包与签名更新源，见 [桌面包构建与更新分发](desktop-distribution.md)。 |
| `POCKET_IM_CALL_STUN_URLS` / `POCKET_IM_CALL_TURN_URLS` / `POCKET_IM_CALL_TURN_SECRET` | Agent 实时音视频通话的跨网络 STUN/TURN 配置，见 [Agent 实时音视频通话](../dev/agent-calls.md)。 |

## 3. 反向代理与 systemd 服务

项目提供模板渲染命令，生成可审查的 systemd 服务单元与反向代理示例（不会直接修改系统配置）：

```bash
npm run deploy:render -- \
  --domain app.example.com \
  --relay-root /opt/fable-pavilion/current \
  --relay-node /usr/bin/node
```

配置反向代理时需确保：

1. 正确传递 `Host`、`Origin` 与 WebSocket `Upgrade` 请求头；
2. 转发 `/api/im/*` 时超时时间**大于 25 秒**（长轮询同步需要），禁用 API 响应缓存，上传请求体上限至少允许 **10 MiB**；
3. 关闭业务正文日志、请求缓冲和自动重试；
4. 仅将真正受控的代理地址填入 `POCKET_RELAY_TRUSTED_PROXIES`（例如仅监听回环时填 `127.0.0.1,::1`），避免信任客户端伪造的 `X-Forwarded-For`。

启动服务：

```bash
POCKET_ENV_FILE=/path/to/private/relay.env npm run relay
```

服务就绪后检查 `GET /health`，确认返回正常且通过 HTTPS 访问网页正常。

## 4. 连接电脑适配器

云端服务上线后，在电脑上安装并启动 [纯 Rust 桌面适配器](../guide/desktop-adapter.md)，在管理页将服务地址设为你的 HTTPS 域名（如 `https://app.example.com`），点击「登录并授权这台电脑」即可完成绑定。

## 5. 数据、备份与升级

- **数据库文件**：位于 `POCKET_RELAY_STATE` 目录下，包括 `relay.sqlite`（设备路由状态）与 `messaging.sqlite`（加密账号、消息元数据与密文）。
- **唯一发号约束**：`messaging.sqlite` 是永久字符串 UID 分配器的唯一来源，切勿复制数据库在多个独立节点同时发号。
- **一致性备份**：升级前请停服复制或使用 SQLite 在线备份 API 保存一致性快照（不要忽略运行中的 WAL 文件），并独立安全备份 `POCKET_IM_TOTP_KEY`。
- **滚动升级与回滚**：
  1. 先在新目录完成构建并验证，再切换软链或服务目录并重启服务；
  2. 不要覆盖或丢弃包含新消息或未确认操作的数据库；若升级失败，优先前滚修复，切勿回退至不识别现有第二因子/安全约束的旧版后端。
- **可选能力**：
  - 私有对象存储扩展见 [对象存储扩展](storage.md)
  - 推送通知见 [推送通知配置](notifications.md)
  - 会员空间与月中转额度见 [可选资源额度（Lago）](resource-limits.md)
