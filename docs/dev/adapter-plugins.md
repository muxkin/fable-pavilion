# 适配器插件与开发

纯 Rust 桌面适配器（`desktop/native`）将通用网关能力（配对、Noise 加密、操作去重、同步、附件授权传输）与具体 Agent 产品的连接逻辑解耦。每个 Agent 实例运行在独立的插件子进程中，拥有隔离的配置、凭据与私有状态目录，支持按实例在线升级与回滚。

## 一、官方内置插件

桌面安装包默认附带三款纯 Rust 官方插件，首次启动时自动校验清单、SHA-256 摘要与 SDK 握手并登记到本地私有注册表：

| 插件标识 | 对应产品 | 说明与配置要点 |
| --- | --- | --- |
| `@agent-remote/adapter-codex` | Codex | 默认实例 ID 为 `codex-local`，自动发现本机状态目录与桌面连接；支持多实例配置（分别指定 `home`、`socket`、`appTools`、`cli`）。支持历史、实时控制、模型/权限/技能/插件、审批、提问、计划确认、用量查询及 Codex Voice。 |
| `@agent-remote/adapter-dsh` | DSH Web | 连接已运行的 DSH Web 实例（配置 `url` 与访问 token 环境变量引用 `secrets.token`）。支持历史、实时流、审批、同步/补答提问、预设、权限、计划、目标管理、技能、反馈与 ZIP 日志导出。 |
| `@agent-remote/adapter-antigravity` | Antigravity | 本机数据目录（默认 `~/.gemini/antigravity`）含 `daemon` 时自动发现为 `antigravity-local`。支持项目与会话同步、超大历史分页、新建/改名/中断/队列/追加、下一轮模型选择、技能与已启用插件选择、单选/多选/手填提问、单次命令审批、图片附件与模型组额度查询。 |

> **运行原则**：插件只连接本机已运行或已存在的 Agent 实例，不负责启动或关闭原 Agent 进程；单实例异常或版本不兼容不会影响同一网关上的其他实例。插件以本机受信任代码运行，进程隔离提供故障遏制而非不可信代码沙箱。

## 二、实例配置（`instances.json`）

适配器读取原生状态目录中的 `instances.json`（或通过 `POCKET_ADAPTERS_FILE` 指定绝对路径）：

```json
[
  {
    "id": "codex-secondary",
    "name": "第二个 Codex",
    "plugin": "@agent-remote/adapter-codex",
    "version": "0.3.73",
    "config": {
      "home": "/absolute/path/to/codex-home",
      "socket": "/absolute/path/to/codex.sock",
      "appTools": "/absolute/path/to/app-tools.sock"
    },
    "secrets": {}
  },
  {
    "id": "dsh-one",
    "name": "我的 DSH",
    "plugin": "@agent-remote/adapter-dsh",
    "version": "0.3.73",
    "config": { "url": "http://127.0.0.1:3080" },
    "secrets": { "token": "DSH_ONE_TOKEN" }
  },
  {
    "id": "antigravity-local",
    "name": "Antigravity",
    "plugin": "@agent-remote/adapter-antigravity",
    "version": "0.3.73",
    "config": { "home": "/absolute/path/to/antigravity" },
    "secrets": {}
  },
  {
    "id": "my-agent",
    "name": "自定义 Agent",
    "plugin": "my-agent-adapter",
    "version": "1.0.0",
    "config": {},
    "secrets": {}
  }
]
```

- `secrets` 中的键指向环境变量名；解析后的真实凭据仅注入该实例的初始化消息，不会写入公开描述或注册表，也不会泄露给其他实例。
- 新增、删除实例或变更连接配置后重启适配器生效；已绑定实例的版本以本地私有注册表为准，修改 JSON 中的 `version` 不会暗中升级。

## 三、安装、在线升级与回滚

将当前平台的自包含插件可执行文件与清单文件 `adapter.json` 放在同一目录即可安装。

`adapter.json` 必须包含：
- `sdk`: `1`
- `name`: 插件包名
- `version`: 确切语义化版本号（同名同版本不可覆盖）
- `product`: 产品标识（或对象存储插件的 `"object-storage"`）
- `stateVersion`: 正整数，标识实例私有状态目录的数据格式版本
- `entry`: 可执行入口文件名（Windows 含 `.exe`）
- `sha256`: 入口文件的十六进制 SHA-256 摘要

管理命令：

```bash
# 安装本地插件目录（校验摘要与 SDK 握手）
agent-space-native --adapter install /absolute/path/plugin-directory

# 查看已安装插件与实例绑定
agent-space-native --adapter list

# 按实例在线升级（要求插件名、product 与 stateVersion 一致）
agent-space-native --adapter upgrade my-agent my-agent-adapter@1.1.0

# 回滚至上一个已绑定的兼容版本
agent-space-native --adapter rollback my-agent

# 查询异步排队切换请求的结果
agent-space-native --adapter result <REQUEST_ID>
```

切换过程会暂缓目标实例的新写请求、等待在途操作持久化落盘后再交接进程；若目标版本初始化失败，会自动保留原绑定并恢复旧进程。

## 四、原生插件协议

原生 SDK 通过标准输入/输出传递带 `Content-Length` 帧头的 **JSON-RPC 2.0** 消息（日志请写入 `stderr` 以免破坏帧结构）。请求在 `params.generation` 中携带进程代次，响应需在顶层回显 `generation` 与 `id`。

| 方法 / 通知 | 方向 | 职责 |
| --- | --- | --- |
| `adapter/check` | 宿主 → 插件 | 握手校验，返回 `{ "sdk": 1 }`。 |
| `adapter/initialize` | 宿主 → 插件 | 传入 `id`、`name`、`config`、`stateDirectory`、`readOnly`、`packageVersion`，返回 `{ "sdk": 1, "watchLifecycle"?: true }`。 |
| `adapter/status` | 宿主 → 插件 | 返回实例公开信息、能力声明与连接状态 `{ info, status }`。 |
| `adapter/read` | 宿主 → 插件 | 执行共享只读查询（项目、会话列表、历史分页、模型/技能目录等）。 |
| `adapter/view` | 宿主 → 插件 | 返回当前订阅会话的归一化快照 `{ thread, messages, observations, streamed?, imageLimits?, continuedQuestions? }`。 |
| `adapter/unwatch` | 宿主 → 插件 | 当插件声明 `watchLifecycle: true` 时，通知释放对应 `watchId` 的本机订阅资源。 |
| `adapter/write` | 宿主 → 插件 | 执行写操作（携带会话 ID、稳定 `requestId` 与动作），返回 `{ state, turnId?, resultThreadId? }`。不确定结果时不得静默重发。 |
| `adapter/threadCreated` | 插件 → 宿主（通知） | 新建会话时在最终响应前尽早回报 `{ requestId, threadId }`，确保后续步骤中断时仍可找回会话。 |
| `adapter/media` / `adapter/export` | 宿主 → 插件 | 返回位于实例目录内的 `{ path, name, temporary?: true }`，由网关负责加密流式传输并在标记 `temporary` 时清理。 |

完整的最小可运行原生插件示例见 `desktop/native/examples/native-plugin-fixture.rs`。

## 五、源码构建与本地验证

```bash
cd desktop/native
cargo build --release --locked --no-default-features --features official-plugins \
  --bin agent-space-adapter-codex \
  --bin agent-space-adapter-dsh \
  --bin agent-space-adapter-antigravity
```

使用打包与隔离冒烟测试脚本验证：

```bash
node scripts/desktop/native-plugin-package.mjs
node --import tsx scripts/desktop/native-smoke.ts <适配器可执行文件> <Codex插件目录>
node --import tsx scripts/desktop/native-dsh-smoke.ts <适配器可执行文件> <DSH插件目录>
node --import tsx scripts/desktop/native-antigravity-smoke.ts <适配器可执行文件> <Antigravity插件目录>
```

> 仓库中 `packages/adapter-sdk` 保留了早期 TypeScript/Node 适配器契约定义与夹具，新插件与桌面端交付请以纯 Rust 原生 SDK 为准。
