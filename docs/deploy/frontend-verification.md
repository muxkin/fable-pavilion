# 前端发布验签

为了降低业务服务凭据泄露后下发恶意前端代码的风险，子虚亭支持通过**独立的静态发布项目（例如 Cloudflare Pages）**托管带签名的前端入口与资源，并配合固定公钥在浏览器与 Android 原生外壳中进行完整性校验：

- **网页端**：浏览器验证签名清单后，逐一核对 HTML、JS 与动态模块的实际字节摘要，通过后才交付执行；业务后端不持有前端签名私钥，也无法关闭已启用的验签策略。
- **Android 验签版 APK**：在打包时内置发布公钥与一份签名网页资源；启动时优先加载本地已验签资源，后台拉取并验证更新清单（要求版本号单调递增且未过期），下次打开时切换生效。

默认部署可以直接使用普通入口，不强制开启验签模式。

## 关键构建与运行开关

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `POCKET_FRONTEND_VERIFY` | `0` | 设为 `1` 时生成独立验签入口与签名资源清单。 |
| `FABLE_ANDROID_FRONTEND_VERIFY` | 继承前者（默认 `0`） | 构建 Android APK 时强制启用原生验签模式。 |
| `FABLE_ANDROID_FRONTEND_RELEASE_DIR` | 无 | 构建验签版 APK 时内置的签名产物目录（如 `dist/frontend-pages/_release`）。 |
| `POCKET_DEVICE_LOGIN_ONLY` | `0` | 可选账号登录策略；设为 `1` 时仅允许已授权设备核对签名批准新设备登录（无在线设备时使用恢复码）。 |

## 1. 生成签名密钥并构建签名包

在独立受控的发布环境生成专用的 RSA 3072 位签名密钥对，将私钥离线妥善保管；构建产物与客户端只分发公钥：

```bash
umask 077
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out /private/frontend-signing.pem
openssl pkey -in /private/frontend-signing.pem -pubout -out /private/frontend-verification.pem

POCKET_ASSET_BASE='' npm run build:web
POCKET_FRONTEND_VERIFY=1 \
  POCKET_FRONTEND_SIGNING_KEY_FILE=/private/frontend-signing.pem \
  POCKET_FRONTEND_PUBLIC_KEY_FILE=/private/frontend-verification.pem \
  POCKET_FRONTEND_RELEASE_VERSION=1 \
  POCKET_FRONTEND_RELEASE_EXPIRES=2027-01-01T00:00:00Z \
  npm run build:frontend-release
```

- 每次新发布必须**递增** `POCKET_FRONTEND_RELEASE_VERSION` 并更新合理的有效期；如需回滚旧版代码，也应使用新的递增版本号重新签名。
- 验签模式要求前端资源保持同源（`POCKET_ASSET_BASE=''`），以便客户端核对全部资源摘要；如前端需直连外部对象存储，可通过 `POCKET_FRONTEND_UPLOAD_ORIGINS` 配置精确 HTTPS origin 列表。

## 2. 通过 Cloudflare Pages 发布

上述构建默认输出到 `dist/frontend-pages`。在独立私有配置目录准备 `wrangler.toml`（不要提交真实项目名或生产域名）：

```toml
name = "your-frontend-pages-project"
pages_build_output_dir = "/path/to/fable-pavilion/dist/frontend-pages"
compatibility_date = "2026-11-04"

[vars]
POCKET_FRONTEND_ORIGIN = "https://app.example.com"

# 后端为 Cloudflare Worker 时使用 Service Binding：
[[services]]
binding = "BACKEND"
service = "your-backend-worker-name"
```

- 执行 `wrangler pages deploy` 发布并绑定自定义域名（签名私钥无需上传到 Pages）。
- **对接 Cloudflare 后端**：确保后端 Worker 的 `POCKET_PUBLIC_ORIGIN` 或 `POCKET_ORIGIN_ALIASES` 包含前端精确 origin；多入口可用逗号分隔的 `POCKET_FRONTEND_ORIGINS`。
- **对接 VPS / Node 后端**：移除 `[[services]]`，改为在 `[vars]` 中配置 `POCKET_BACKEND_ORIGIN` 指向 VPS/Tunnel 的 HTTPS 上游地址；同时在 VPS 侧保持 `POCKET_PUBLIC_ORIGIN` 为浏览器访问的前端 origin，并设置 `POCKET_RELAY_UPSTREAM_ORIGIN` 为该上游地址。
- **独立入口 Worker（可选）**：若需通过自定义入口 Worker 路由，可部署 `scripts/frontend-release/frontdoor.js`，配置 `POCKET_FRONTEND_ORIGINS`、`BACKEND` 与 `POCKET_VERIFIED_PAGES`。

## 3. 可选：仅设备核验登录模式（`POCKET_DEVICE_LOGIN_ONLY=1`）

当部署希望彻底移除服务端密码包装根密钥与 TOTP 种子时，可在前后端同时启用 `POCKET_DEVICE_LOGIN_ONLY=1`：

1. 新设备扫码后展示基于新设备公钥派生的核对码，由已授权设备核对签名并加密交接账号根密钥，服务端使用账号公钥验签。
2. 构建并签署前端时须携带 `POCKET_DEVICE_LOGIN_ONLY=1`，使受信前端固定该策略，避免后端响应降级。
3. 切换存量站点前，请确认用户至少保有一台可解锁设备或已妥善保存 256 位恢复码；后端会在校验恢复密钥包后在事务中移除旧密码包装与 TOTP 种子，保留原账号根密钥、会话与电脑授权。
