# `packages/` 说明

本目录保留三组 TypeScript / Node 内部工作区包：

- **`packages/adapter-sdk`**：共享 TypeScript 协议与类型定义，当前仍被 `src/shared/`、`src/server/`、`src/web/` 与 `vite.config.ts` 直接复用。
- **`packages/adapter-codex` 与 `packages/adapter-dsh`**：进程内 Node / TypeScript 测试夹具与兼容实现，供 Vitest 单元测试、`test/cloudflare/runtime.test.ts` 与 `scripts/smoke/` 浏览器回归在不拉起真实桌面客户端的情况下驱动完整端到端流程。

> 生产环境的桌面端交付与插件宿主已完全切换为纯 Rust 实现（见 [desktop/native](../desktop/native) 与 [适配器插件说明](../docs/dev/adapter-plugins.md)），不包含 Node 或 Python 运行时依赖。
