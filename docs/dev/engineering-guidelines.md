# 工程规范与开发红线

本文面向所有贡献者与 AI 编码助手，明确仓库在安全边界、架构分层、模块拆分、测试编写与文档维护上的硬性约束。开始改动前请先通读本文。

## 1. 安全、隐私与去定制红线

- **禁止提交私有与个人数据**：任何源码、测试、配置、脚本或文档中，都不得写入个人域名、真实邮箱、本机用户名或主机名、服务器 IP、云账户 ID、私钥、Token、数据库、赞赏码图片、签名 APK 或设计稿源文件（`.kra` / `.xcf` 等）。示例地址与账号必须使用 RFC 保留占位域（如 `example.com`、`example.org`、`*.test`、`*.invalid`）。
- **站点差异化走部署参数**：赞赏信息（`POCKET_SUPPORT_CONFIG` / `POCKET_SUPPORT_QR_FILE`）、Android 分发包（`POCKET_ANDROID_DOWNLOADS_DIR`）、跨站扫码白名单（`POCKET_LOGIN_REDIRECT_ORIGINS`）、静态资源基址（`POCKET_ASSET_BASE`）与发行仓库地址（`POCKET_RELEASE_REPO`）一律在构建/部署期注入，不得硬编码到公开源码或默认公共静态目录。
- **对象存储与外部能力走通用协议**：桌面端对象存储统一采用通用原生存储插件协议（`POCKET_NATIVE_STORAGE_PLUGIN`），禁止在默认构建或核心源码中硬编码特定云厂商的私有鉴权、发现或上传逻辑。
- **变更不破坏既有数据**：涉及存储、迁移、协议或配置重构时，必须保留已有设备身份、配对记录、离线密钥、账号凭据、会话历史与附件。

## 2. 架构分层与模块化红线

- **一份应用、双云端运行时**：VPS/Node 与 Cloudflare Workers 必须共用同一套前端、加密协议与共享业务逻辑（`src/shared`、`src/client`、共享服务端模块）。运行时专属代码（`src/cloudflare`、`src/server` 入口）只允许处理 I/O、存储、定时与平台绑定，禁止分叉出“个人版/Cloudflare 版”独立功能实现。
- **纯 Rust 桌面适配器边界**：
  - 桌面适配器保持无窗口后台运行，通过系统托盘与回环管理页交互，同时支持无托盘模式；安装包不得捆绑 Node 或 Python 运行时。
  - Codex、DSH、Antigravity 等产品连接器通过独立 Rust 插件进程运行，禁止重新塞回默认网关主进程。
  - 默认构建必须包含并启用 WebRTC 工作台直连与附件传输，以中继和可选对象存储作为回退路径。
- **控制单文件体积与样式边界**：
  - 单个代码文件超过约 600–800 行时，新增功能前应先按职责拆分为子模块或组件（Rust 拆 submodule、Vue/TS 拆组件与 helper），禁止不断往已有大文件堆叠无关逻辑。
  - 全局基础样式统一收敛在 `src/web/styles/`（`base.css`、`workspace.css`）与各功能域样式中，禁止新增零散且互相覆盖的顶层全局 CSS 文件。

## 3. 测试与脚本卫生红线

- **禁止遗留一次性脚本**：不要把临时排障、单次 QA 或功能草稿脚本提交到 `scripts/`。新增的端到端测试（`scripts/**/*-smoke.*`）**必须**接入 `package.json` 或 `.github/workflows/`（`scripts/lib/` 共享夹具除外），否则会在 `npm run check:public` 中被拒绝；一次性验证脚本应放在系统临时目录，用完即删。
- **浏览器端到端测试必须隔离且确定**：
  - 禁止硬编码固定监听端口（如 `18917`），必须使用 `scripts/lib/messaging-smoke.ts` 的 `allocateLocalPort()` 动态分配空闲端口，仅允许通过 `TEST_PORT` 显式覆盖。
  - 输出与截图目录必须支持 `TEST_OUTPUT` 环境变量，默认使用 `mkdtemp` 隔离临时目录；`catch` 块中的失败截图必须 `.catch(() => {})` 防止掩盖真实异常；`finally` 必须完整关闭所有浏览器 Context/Page 与本地服务。
  - 禁止编写脆弱的时间精确相等断言（如 `toHaveText('0:02 / 2:00')`）或无条件固定 `waitForTimeout` 盲等；优先使用条件轮询（`expect.poll` / `toBeVisible` / 事件监听）。
- **单元测试禁止污染宿主机环境**：
  - Node（Vitest）与 Rust（`cargo test`）单元测试不得读取宿主机真实的 `~/.config`、`$XDG_CONFIG_HOME`、`local/gateway.env` 或真实在线服务；涉及状态目录发现的逻辑必须以显式目录参数判定，确保在已安装桌面适配器的开发机上直接运行 `cargo test` 也能 100% 通过。
  - 异步就绪等待应使用事件或 `vi.waitFor` / 显式条件，避免用几十毫秒的固定 `setTimeout` 赌时序。

## 4. 文档维护红线

- **遵守三层目录结构**：所有文档严格归类到 `docs/guide/`（用户指南）、`docs/deploy/`（自部署与运维）或 `docs/dev/`（架构与开发），并在 [docs/README.md](../README.md) 登记入口。禁止在 `docs/` 根目录堆放平铺文档（除 `docs/README.md` 外会被 `npm run check:public` 拦截）。
- **只写面向读者的结果文档**：文档必须准确反映当前实现，禁止写入开发过程流水账、临时分支名、未验证占位词或内部工具工作流。
- **代码与文档同步更新**：新增或变更环境变量、CLI 参数、插件协议、部署步骤或重要行为时，必须在同一提交中同步更新 `.env.example` 与对应文档。

## 5. 提交前强制验证清单

暂存待提交文件后，按改动范围运行对应检查并确认全部通过：

```bash
# 1. 公开树安全与结构卡口（所有改动必跑）
npm run check:public

# 2. 类型检查与单元测试（改动 TS/Web/Server 时必跑）
npm run typecheck
npm test

# 3. 双云端一致性与 Cloudflare 契约（改动 Web/Server/Cloudflare/构建配置时必跑）
npm run typecheck:cf
npm run test:cf
npm run check:deployments

# 4. Rust 桌面适配器与官方插件（改动 desktop/native 时必跑）
cargo test --manifest-path desktop/native/Cargo.toml --locked --features official-plugins --lib
cargo check --manifest-path desktop/native/Cargo.toml --locked --no-default-features --features official-plugins --bins
```

> 本地存在私有 `local/gateway.env` 时，运行同源浏览器端到端回归前，请使用 `POCKET_ENV_FILE=/dev/null npm run build:web` 构建干净的本地前端包，避免引入外部 CDN 基址触发同源 CSP 拦截。
