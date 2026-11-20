# 子虚亭文档中心

欢迎查阅子虚亭（Fable Pavilion）的完整文档。文档按使用场景分为**用户指南**、**自部署与运维**和**架构与开发**三部分。

## 用户指南

- [桌面适配器安装与配置](guide/desktop-adapter.md)：Windows、macOS、Linux 纯 Rust 适配器安装、账号授权、离线秘钥簿、多实例管理与自动更新。
- [使用指南与能力范围](guide/usage.md)：工作台操作、消息与群聊、模型与工具菜单、附件与富文本、通知、主题缓存，以及各 Agent 的支持边界。
- [账号安全与加密机制](guide/security.md)：账号解锁、恢复码、默认动态码、扫码登录、通行密钥、客户端加密模型与安全信任边界。
- [Android 客户端](../android/README.md)：Android 客户端使用说明、签名构建与可选验签模式。

## 自部署与运维

- [VPS 部署指南](deploy/vps.md)：在 Linux 服务器上部署 Node 中继与静态网页，包含环境变量、反向代理、备份与升级。
- [Cloudflare 部署指南](deploy/cloudflare.md)：使用 Cloudflare Workers、Durable Objects、R2 和 Images 部署独立实例。
- [对象存储扩展](deploy/storage.md)：配置可选的私有对象存储作为大附件密文回退路径。
- [推送通知配置](deploy/notifications.md)：配置网页端 Web Push（VAPID）与 Android UnifiedPush 通知。
- [可选资源额度（Lago）](deploy/resource-limits.md)：接入自托管 Lago 实现附件空间和月中转流量策略，以及客户端解密导出和手动清理。
- [前端发布验签](deploy/frontend-verification.md)：通过独立 Pages 项目向浏览器与 Android 客户端分发签名网页资源。
- [桌面包构建与更新分发](deploy/desktop-distribution.md)：为自托管站点构建、签名并托管纯 Rust 桌面适配器安装包，以及统一云端发行校验。
- [一次性账号加密迁移](deploy/account-migration.md)：将历史明文消息库安全迁移至端到端加密格式的一次性工具说明。
- [支持项目页面配置](deploy/donations.md)：配置「我的 → 支持项目」页面的公开赞赏信息。

## 架构与开发

- [工程规范与开发红线](dev/engineering-guidelines.md)：安全去定制边界、模块拆分要求、测试卫生、文档规范与提交前强制验证清单（面向人类贡献者与 AI 助手）。
- [系统架构与通信协议](dev/architecture.md)：VPS/Cloudflare 共享核心边界、设备协议 v2（Noise / WebRTC / WSS / 同步缓存）与 Vue 3 前端模块结构。
- [适配器插件与开发](dev/adapter-plugins.md)：纯 Rust 原生插件协议（JSON-RPC 2.0）、Codex/DSH/Antigravity 官方插件能力矩阵、多实例配置与源码构建。
- [即时消息 API 与 Agent 接入](dev/messaging-api.md)：人类与 Agent 统一账户、字符串 UID、加密 HTTP API、CLI、流式回复、交互卡片与原生运行器协议。
- [Agent 实时音视频通话](dev/agent-calls.md)：WebRTC 双向音视频通话协议、Node 与原生媒体处理器接口及 STUN/TURN 配置。
- [贡献与开发指南](../CONTRIBUTING.md)：本地开发环境、测试套件、公开安全检查与提交流程。
