# Cloudflare 部署指南

Cloudflare 部署与 VPS/Node 部署共用同一套前端、加密协议与业务核心，仅在入口、持久化与平台绑定上使用 Cloudflare Workers 生态。新建的 Cloudflare 实例与已有 VPS 实例数据相互独立。

## 运行组件映射

| 逻辑组件 | Cloudflare 实现 |
| --- | --- |
| Web / PWA 静态站点 | Worker Static Assets（构建输出至 `dist/cloudflare-web`） |
| `/connect` 加密中继与信令 | `RelayHub` Durable Object（双通道 + 休眠 WebSocket） |
| `/api/im/*` 账号与加密消息 | `MessagingHub` Durable Object + SQLite |
| 消息附件、表情包与头像 | 私有 R2 Bucket（`IM_MEDIA`），下载经账号/会话成员鉴权 |
| 头像裁切缩放 | Cloudflare `IMAGES` binding（256 × 256 WebP） |
| 桌面适配器 | 仍在用户电脑运行，主动连接所选的 Cloudflare 入口 |

- 工作台大附件仍优先走 WebRTC 直连或 WSS，必要时由桌面适配器配置独立对象存储。
- R2 `IM_MEDIA` 用于持久保存即时消息的加密附件，**切勿为该 Bucket 配置 24 小时自动过期策略**，否则会导致历史消息附件失效。

## 1. 环境准备与配置

本地构建需要 **Node.js 24.15+**，以及已开通 R2 与 Images 功能的 Cloudflare 账户：

```bash
git clone https://github.com/muxkin/fable-pavilion.git
cd fable-pavilion
npm ci
npx wrangler login
```

根据你的站点修改 `wrangler.jsonc`（或使用独立私有配置文件，避免把真实配置提交至公开仓库）：

- `name`：你的 Worker 名称。
- `vars.POCKET_PUBLIC_ORIGIN`：最终访问的精确 HTTPS origin（不含路径与尾斜杠），例如 `https://app.example.com` 或 `https://<worker>.<subdomain>.workers.dev`。
- `r2_buckets[0].bucket_name`：你的私有消息 R2 Bucket 名称。
- `vars.POCKET_IM_REGISTRATION_ENABLED`：设为 `"false"` 关闭自助注册（默认允许）。
- `routes`：绑定自定义域名时可添加 `[{ "pattern": "app.example.com", "custom_domain": true }]`。

## 2. 创建存储并设置密钥

```bash
# 创建私有 R2 Bucket（名称与配置保持一致）
npx wrangler r2 bucket create your-im-media-bucket

# 设置主机注册密钥（至少 32 字符随机私有值）
npx wrangler secret put POCKET_RELAY_ENROLLMENT

# 设置账号动态码种子加密密钥（请用下列命令生成并独立安全备份）
# node -p "require('node:crypto').randomBytes(32).toString('base64url')"
npx wrangler secret put POCKET_IM_TOTP_KEY

# 可选：开放注册时要求注册邀请码
npx wrangler secret put POCKET_IM_REGISTRATION_CODE
```

请勿将任何密钥写入 `wrangler.jsonc`。

### 可选环境变量（Worker `vars` / `secrets`）

- **站内划词翻译**：设置 `vars.POCKET_TRANSLATION_URL`（如 `https://translate.example.com/translate`），需要鉴权时运行 `npx wrangler secret put POCKET_TRANSLATION_API_KEY`。
- **外部对象存储直传**：若桌面适配器使用独立对象存储，将对应精确 HTTPS origin 加入 `vars.POCKET_UPLOAD_ORIGINS`。
- **独立 CDN**：构建时通过 `POCKET_CF_ASSET_BASE`（或 `POCKET_CF_ENV_FILE`）设置静态资源基址，并在 `vars.POCKET_ASSET_BASE` 中保持一致。
- **跨站扫码白名单 / 赞赏信息 / Android 安装包**：构建时可通过环境变量或 `POCKET_CF_ENV_FILE` 注入 `POCKET_LOGIN_REDIRECT_ORIGINS`、`POCKET_SUPPORT_CONFIG`、`POCKET_SUPPORT_QR_FILE` 与 `POCKET_ANDROID_DOWNLOADS_DIR`，与 VPS 保持完全一致。
- **推送通知 / 资源额度 / 实时通话**：参见 [推送通知配置](notifications.md)、[可选资源额度（Lago）](resource-limits.md) 与 [Agent 实时音视频通话](../dev/agent-calls.md)。

## 3. 验证与发布

```bash
npm run typecheck
npm run typecheck:cf
npm run test:cf
npm run build:cf      # 本地构建与 dry-run 检查
npm run deploy:cf     # 发布到你的 Cloudflare 账户
```

> `npm run build:cf` 不会读取本机私有的 `local/gateway.env`，也不会覆盖 VPS 构建目录 `dist/web`。使用统一发行守卫时，可按 [桌面包构建与更新分发](desktop-distribution.md#统一云端发行校验) 执行预编译校验。

## 4. 为现有实例更换域名

若需将已运行的 Cloudflare 实例迁移至新域名并保持旧入口兼容：

1. 将新旧自定义域名同时绑定到原有 Worker，保持 Worker、DO 类名与对象名、R2 Bucket 和所有密钥不变；
2. 将 `vars.POCKET_PUBLIC_ORIGIN` 更新为新入口（如 `https://new.example.com`），将旧入口加入 `vars.POCKET_ORIGIN_ALIASES`（多个用逗号分隔）；
3. 将 `vars.POCKET_IM_IDENTITY_ORIGIN` 保持为原入口，以维持既有完整账号标识域名不变；
4. 若启用了 Lago 资源策略，继续保留原来的 `POCKET_RESOURCE_INSTANCE`。

访问新域名的用户重新登录后，已同步至云端账号的会话与电脑授权会自动恢复。

## 5. 本地测试与开发调试

- `npm run test:cf` 基于隔离的 Miniflare / `workerd`、临时 SQLite/R2 与模拟 Images 运行全套中继与消息契约测试，不依赖真实云端资源。
- 如需本地交互调试，在被 Git 忽略的 `.dev.vars` 中写入测试密钥与 origin 后运行：
  ```bash
  npm run dev:cf -- --local-protocol https --port 8787
  ```

## 6. 运维边界与注意事项

- **单实例设计**：每个部署使用一个中继 DO（`RelayHub`）和一个消息 DO（`MessagingHub`），确保单源 UID 分配、事务幂等与全局连接配额语义。该架构适合个人与中小规模独立部署，并非跨区域多活或分片数据库。
- **平台配额与计费**：DO 存储/CPU/休眠计费及 Images 处理计费请参考 Cloudflare 官方文档（[Durable Objects 定价](https://developers.cloudflare.com/durable-objects/platform/pricing/)、[Durable Objects 限制](https://developers.cloudflare.com/durable-objects/platform/limits/)、[Images Binding](https://developers.cloudflare.com/images/optimization/binding/)）。长轮询（最长 25 秒）会产生相应的 DO 活跃时长消耗。
- **切勿重命名持久化标识**：升级时不得随意更改 DO 类名、Binding 名或删除 Namespace，否则会产生全新的空数据实例。
- **日志隐私**：默认关闭 Worker 请求观测日志（`observability.enabled = false`），切勿在自定义日志中记录请求正文、Cookie、配对链接或账号密钥。
