# 开发与贡献指南

项目服务端与前端使用 **Node.js 24+**，桌面适配器与官方插件使用 **Rust**（工具链版本见 `desktop/native/rust-toolchain.toml`）。

## 提交前检查

提交代码前请运行基础检查套件：

```bash
npm ci
npm test
npm run typecheck
npm run typecheck:cf
npm run test:cf
npm run check:deployments
POCKET_ENV_FILE=/dev/null npm run build
```

若修改了桌面适配器或官方插件，请在 `desktop/native` 中同步运行：

```bash
cd desktop/native
cargo test --locked
```

> 不要在正在运行的线上发行目录中直接执行试验构建；请始终在隔离目录构建并验证。

## 仓库目录结构

| 目录 | 内容 |
| --- | --- |
| `src/web` | Vue 3 + Vite + TypeScript 前端界面、工作台与持久缓存 |
| `src/server` | 云端中继核心、账户与加密消息服务、资源策略与部署工具 |
| `src/cloudflare` | Cloudflare Workers、Durable Objects 与 R2 运行时适配 |
| `src/shared` | 共享业务协议、Noise 通道、增量同步与文件编码 |
| `src/client` | 浏览器与 Node 共用的加密消息、通话与测试客户端 |
| `desktop/native` | 纯 Rust 桌面适配器、离线秘钥簿与官方 Codex/DSH/Antigravity 插件 |
| `android` | Android WebView 外壳、通知与可选前端验签模块 |
| `packages` | 早期 TypeScript 适配器 SDK 契约定义与测试夹具 |
| `deploy/lago` | 可选的自托管 Lago 资源额度部署模板 |
| `test` | 单元测试、共享契约测试与 Cloudflare `workerd` 测试 |
| `scripts` | 浏览器回归、桌面打包签名、密文存储校验与公开安全检查脚本 |
| `docs` | [用户指南、自部署运维与开发文档](docs/README.md) |

## 浏览器端到端回归测试

浏览器回归依赖本机 Chrome / Chromium。请先构建一份隔离的同源前端产物，再指定 `TEST_WEB_ROOT` 运行对应测试：

```bash
POCKET_ENV_FILE=/dev/null POCKET_ASSET_BASE= npx vite build --outDir /tmp/fable-pavilion-web
export TEST_WEB_ROOT=/tmp/fable-pavilion-web

npm run test:browser
npm run test:frontend
npm run test:layout
npm run test:composer
npm run test:delivery
npm run test:conversation-replay
npm run test:messaging
npm run test:messaging-design
npm run test:im-calls
npm run test:controls
```

- 以上脚本在 loopback 上启动临时中继与模拟桌面夹具，使用合成测试数据，不触碰真实桌面会话或生产账号。
- 可通过 `TEST_PORT` 指定隔离端口；如需在局域网或受控内网设备调试，可显式设置 `TEST_BIND`。不要将测试夹具暴露到公网。
- Node 与 Cloudflare 的前端一致性校验由 `npm run check:deployments` 完成，详见 [系统架构与通信协议](docs/dev/architecture.md)。

## 提交 Issue 与 PR

- **Issue**：请附带操作系统、客户端/浏览器版本、对应 Agent 版本、复现步骤以及预期与实际行为。上传日志或截图前请务必移除凭据、真实会话正文与个人本机路径。
- **Pull Request**：请说明用户可见变更与验证方式。涉及统一云端逻辑的改动应落在共享核心模块，确保 VPS/Node 与 Cloudflare 行为一致；涉及桌面写操作的改动应保持请求去重、归属校验与「结果待确认」保护。

## 公开安全检查

每次提交或发布前，请在暂存待提交文件后运行：

```bash
npm run check:public
```

该脚本检查 Git 暂存区，拒绝私密配置、密钥、数据库、本机状态目录、设计草稿以及已知凭据或内部文档泄露模式。自动检查不能替代人工复核——发布前仍应确认 Git 历史、截图元数据和新增配置均只包含通用示例值（如 `example.com`），不夹带个人域名、私有服务凭据或本机绝对路径。

应用版本以根目录 `package.json`（及桌面端 `desktop/native/Cargo.toml`）为准，发布前同步更新 [CHANGELOG.md](CHANGELOG.md)，待对应提交的 CI 契约测试全部通过后再打标签触发 GitHub Release。
