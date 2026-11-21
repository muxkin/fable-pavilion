# 系统架构与通信协议

子虚亭采用“**统一核心，多运行时适配**”架构：

- **云端（VPS/Node 与 Cloudflare Workers）**共享同一套前端、加密协议与业务逻辑，仅在入口、持久化与基础设施绑定层适配。
- **桌面端**由纯 Rust 适配器（`desktop/native`）与独立原生插件进程组成，无 Node/Python 运行时依赖，不监听公网入站端口。
- **客户端**包含 Web/PWA（Vue 3 + Vite + TypeScript）与 Android WebView 原生外壳（`android/`）。

## 一、模块与共享边界

| 能力域 | 共享核心位置 | 运行时差异 |
| --- | --- | --- |
| Web / PWA 界面与工作台 | `src/web` | Node 静态服务 / Cloudflare Worker Static Assets |
| 独立零知识运维管理台 | `src/admin`、`scripts/admin-release` | Node `/admin/` 静态挂载 / 独立 Cloudflare Pages 站点 |
| 客户端加密账号、消息与协议 | `src/client`、`src/shared` | 无平台分支 |
| 账户、联系人、消息、附件、7 天清理与管理 API | `src/server/messaging/service-core.ts`、`store-core.ts`、`admin-queries.ts` | Fastify / Worker HTTP；本机 SQLite / DO SQLite |
| 密文中继路由、鉴权、连接配额与转发 | `src/server/relay-core.ts` | Node `ws` / Durable Object 休眠 WebSocket |
| 资源策略计量与 Lago 适配 | `src/server/resources/service.ts`、`lago.ts` | 同名环境变量 / Worker bindings |
| 浏览器安全头与 CSP | `src/server/edge-policy.ts` | 各运行时写入 HTTP 响应头 |
| 桌面适配、离线秘钥簿与插件宿主 | `desktop/native` | Windows/macOS/Linux 仅在系统凭据保护与托盘 I/O 层区分 |
| Android 客户端与增量验签热更新 | `android/` | 仅预取核心入口壳文件，其余 chunk 按需验签缓存并复用 HTTP/2 连接 |

### 架构一致性约束

- 新增功能与修复优先修改共享核心，不在 VPS 与 Cloudflare 之间维护不同的业务分支。
- Node 与 Cloudflare 共同执行 `test/contracts/` 中的中继、桌面备份与通话契约测试。
- 运行 `npm run check:deployments` 可校验在相同公开构建参数下，Node 与 Cloudflare 构建出的前端文件逐文件 SHA-256 完全一致。

## 二、设备通信协议（v2）

### 1. 身份认证与 Noise 加密通道

- 桌面主机与手机/浏览器客户端各自生成独立的 **Ed25519** 身份密钥。配对通过一次性授权或短期二维码完成，配对凭据在 5 分钟或首次消费后原子失效。
- 云端中继仅通过挑战-响应验证主机路由身份、维护短期路由票据与连接配额，**不参与业务层解密**，信令与路由帧不携带会话正文或文件密钥。
- 每条传输路径均分为 `control`（控制与会话同步）和 `bulk`（文件块传输）双通道，每条通道各自建立独立的 **`@libp2p/noise`** 认证加密连接，并绑定协议版本与通道 prologue。
- 客户端优先建立加密 WSS 连接，同时后台通过 Trickle ICE 尝试升级为端到端加密 **WebRTC 直连**（仅使用 STUN，不依赖 TURN）。直连就绪后 WSS 短暂中断不会关闭健康的直连通道；任意路径断线后可独立重连并从检查点恢复。

### 2. 幂等操作与增量同步

- **请求标识分离**：传输层包 `id` 仅标识单次 RPC 尝试；写操作业务体的 `requestId` 跨重连和路径切换持久标识一次业务动作。网关按 `(backend_id, id)` 持久记录操作状态（收到/分发/完成/拒绝/结果待确认），杜绝网络超时导致重复执行。
- **方法白名单**：`src/shared/rpc.ts` 定义有限的业务方法白名单，不存在向桌面转发任意 RPC 或开放任意路径文件代理的入口。
- **增量与缺口恢复**：会话订阅携带 `epoch`、`revision` 与消息内容哈希清单。连续修订号直接重放有界增量日志；遇到缺口、删除、重排或新世代时，按清单仅传输发生变化的正文，显著降低重连流量。

### 3. 分块加密文件与本地播放

- 附件路由顺序：`本地缓存 → WebRTC 直连（打洞最多等待 2 秒） → 加密 WSS（≤ 8 MiB） → 可选私有对象存储密文回退（> 8 MiB） → WSS 兜底`。
- 单文件上限 256 MiB，按 **1 MiB 明文块**独立使用 AES-256-GCM 加密（每版本随机文件密钥，AAD 绑定文件 ID、版本、块号与明文长度），支持按块 SHA-256 校验与缺失块续传。
- 浏览器优先使用 OPFS（回退 IndexedDB）缓存校验块；Service Worker 通过不透明的 `/local-files/<capability>` 路径为音视频和预览提供本地 HTTP `Range` 响应，从不向云端明文请求附件。

## 三、前端模块结构

前端基于 Vue 3、Vite 与 TypeScript（`.vue` 与 Vue TSX 共存），核心结构位于 `src/web`：

- `shell/AppShell.tsx`：负责全局响应式布局（宽屏左侧导航、窄屏悬浮底部导航与安全区、单一视口/软键盘监听）及四大一级模块生命周期；切换模块时保持工作台挂载以保留草稿与实时连接。
- `ChatComposer`、`SendButton`、`RichMessage`、`FileAttachment`、`RequestCards`、`ImagePreview`：由工作台与即时消息模块共用；`AttachmentAccessContext` 按模块注入各自的附件授权读取器。
- `theme/`：基于 Material Color Utilities 实现子虚亭昼夜主题与自定义主题引擎，支持 JSON 导入导出。
- **缓存设计**：持久化缓存按设备身份、主机与会话隔离，由浏览器自身配额管理，不设应用级自动淘汰；清理缓存时保留设备身份、草稿、续传记录与未确认操作。

## 四、命名与兼容说明

因项目经历了从早期 Codex 移动端远程网关向多 Agent 空间与纯 Rust 桌面适配器的演进，部分底层包名、二进制名与环境变量沿用历史标识以保障既有设备状态目录、配置与升级通道无感兼容：

| 标识 | 用途与保留原因 |
| --- | --- |
| **子虚亭 · Fable Pavilion** | 当前对外产品与仓库名称 |
| `agent-space-native`、`agent-space-adapter-*`、`@agent-remote/adapter-*` | 纯 Rust 桌面适配器与官方原生插件的可执行文件名、包名与桌面启动器标识（`org.agent-space.adapter`），直接关联已安装客户端的自启动项与静默自动更新 |
| `codex-pocket-remote`、`POCKET_*` | 根 `package.json` 包名与全量环境变量前缀，保持自部署配置文件、Worker 绑定与迁移脚本向后兼容 |

## 五、设计参考

项目的交互与架构设计参考了以下开源项目与公开规范：

- [Codex Mini](https://github.com/CoimgRain/Codex-Mini)：移动端体验、队列与缓存思路
- [codex-desktop-linux](https://github.com/ilysenko/codex-desktop-linux)：共享桌面 App Server 的适配思路
- [Faryo](https://github.com/SongJunguo/faryo-codex-web-ui)：流式与完成态内容渲染
- [Codex Mobile](https://github.com/Ike-li/codex-mobile)：配对、审批与连接状态处理
- [Agent Client Protocol (ACP)](https://agentclientprotocol.com/protocol/v1/initialization) 与 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：能力协商与外部会话控制参考
