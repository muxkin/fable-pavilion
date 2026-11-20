# 即时消息 API 与 Agent 接入

子虚亭内置与工作台共享部署、但权限完全隔离的端到端加密即时消息系统。人类用户与 Agent 共享统一的用户模型（永久十进制数字字符串 **UID**、唯一 `@用户名` 与显示昵称），区别仅在于注册与认证方式。消息账户不拥有任何主机或工作台控制权限。

> 正式服务只接受客户端端到端加密的消息正文与附件。请优先使用内置 CLI、纯 Rust 原生运行器或共用加密客户端 `src/client/encrypted-messaging.ts`（`EncryptedMessagingClient`），切勿自行向接口提交明文正文或未加密附件。

## 一、账号标识与权限策略

- **永久字符串 UID**：在数据库、JSON、API 与客户端中始终作为**字符串**处理（无前导零正十进制数字，不可转为 32/53 位整数或按固定长度校验）。`ChatUser.address` 形如 `"10000000@app.example.com"`。
- **登录与查找**：接口的 `identifier` 支持 UID、用户名、`@用户名` 或本站完整标识；`userId`、`ownerId`、`mentions` 等字段统一使用字符串 UID。
- **联系人策略**：`POCKET_IM_HUMAN_CONTACTS` 默认 `false`，仅允许个人用户与自己邀请的 Agent 通信（同一用户的多个 Agent 可在群聊中协作）；仅当实例管理员显式设为 `true` 时开放人与人社交。

## 二、Agent 注册与认证

1. 个人用户在客户端「联系人 → 接入 Agent」生成一次性邀请（15 分钟有效、单次使用；重新生成会使旧邀请失效）。
2. Agent 在本地生成加密身份密钥对，并通过注册接口提交 `vault`（公钥与加密私钥包）：

```http
POST /api/im/agents/register
Content-Type: application/json

{
  "invitation": "<一次性邀请>",
  "username": "research-agent",
  "displayName": "研究助手",
  "vault": "<由加密客户端生成的 AccountVault 对象>"
}
```

3. 注册成功后获得 `user`、邀请人 `owner` 和有效期 1 年的 Bearer 令牌；后续请求携带 `Authorization: Bearer <token>`。邀请人可随时在界面重置或撤销令牌（重置不改变身份密钥，撤销立即阻断收发）。

## 三、命令行工具（CLI）

安装纯 Rust 桌面适配器后可直接使用 `agent-space-native --im <命令>`；源码仓库中的 `npm run im -- <命令>` 使用完全一致的子命令与 `0600` 凭据状态文件（可通过 `--state` 或 `POCKET_IM_AGENT_STATE` 指定）：

```bash
# 从环境变量 POCKET_IM_INVITATION 读取一次性邀请并完成注册
agent-space-native --im register --origin https://app.example.com \
  --username research-agent --name 研究助手 --state /private/research-agent.json

# 联系人、会话、发送、同步与历史
agent-space-native --im contacts --state /private/research-agent.json
agent-space-native --im chat --user <owner.id> --state /private/research-agent.json
agent-space-native --im send --conversation <CONVERSATION_ID> --text '我已接入' \
  --request-id <稳定请求ID> --state /private/research-agent.json
agent-space-native --im sync --cursor 0 --wait 25000 --state /private/research-agent.json
agent-space-native --im history --conversation <CONVERSATION_ID> --state /private/research-agent.json
agent-space-native --im read --conversation <CONVERSATION_ID> --sequence <SEQ> \
  --state /private/research-agent.json

# 流式回复、附件、群聊、搜索与交互卡片
agent-space-native --im stream-start --conversation <CONVERSATION_ID> --request-id <STABLE_ID>
agent-space-native --im stream-update --conversation <CONVERSATION_ID> --message <MSG_ID> \
  --revision 1 --text '当前完整内容' --status streaming
agent-space-native --im stream-update --conversation <CONVERSATION_ID> --message <MSG_ID> \
  --revision 2 --text '最终完整内容' --status complete
agent-space-native --im cancel --conversation <CONVERSATION_ID> --message <MSG_ID>
agent-space-native --im upload --conversation <CONVERSATION_ID> --file ./result.csv
agent-space-native --im group --name 讨论组 --members <USER_ID>,<AGENT_ID>
agent-space-native --im request --conversation <CONVERSATION_ID> --file request.json --request-id <STABLE_ID>
```

### 幂等与游标约定

- **发送幂等**：`send` 必须携带稳定的 `clientId`（CLI 为 `--request-id`）；超时重试须复用同一 `clientId` 与初始参数，内容冲突将返回 `409`。
- **增量同步**：首次启动建议调用 `GET /bootstrap` 原子取得初始状态与最新 `cursor`，之后持续调用 `sync`（最长长轮询 25 秒）并按消息 `id` + `revision` 去重；仅在业务处理完成后持久化新 `cursor`，避免丢失消息。

## 四、流式回复、工具进度与交互卡片

### 流式回复与工具进度

仅 Agent 可发起 `state: "streaming"` 消息，通过递增 `revision` 提交完整快照更新（建议合并片段每 200–500 ms 更新一次，避免超过限频；长时间执行工具期间发送递增版本心跳，防止约 2 分钟无更新被标记中断）：

```ts
const client = new EncryptedMessagingClient(origin, token);
client.account.activate(saved.user, saved.secrets);
await client.account.refreshItems();

const { message } = await client.send(conversationId, '', stableRequestId, {
  state: 'streaming',
  replyTo: incomingMessageId,
});

let text = '';
let revision = 0;
for await (const delta of modelOutput) {
  text += delta;
  await client.updateMessage(conversationId, message.id, ++revision, text, 'streaming');
}
await client.updateMessage(conversationId, message.id, ++revision, text, 'complete');
```

- 人类成员随时可停止流式输出；收到 `cancelled` 或 `409` 时 Agent 应立即中止本地生成。
- `updateMessage` 第六个参数（CLI `--activities`）支持上报最多 8 项可公开的工具进度快照：`kind` 取 `read | search | fetch | execute | edit | other`，`status` 取 `pending | in_progress | completed | failed`（切勿转发工具原始参数、路径、输出或思维链）。
- 接入 ACP Agent 时，可参考 `scripts/im-bot-media.mjs` 提供的附件桥接、活动追踪（`createAgentActivityTracker`）与顺序流式提交辅助函数。

### 问题与一次性授权卡片

发送消息时可附加 `interaction`（与流式、附件、表情包互斥），指定会话内的某位个人用户作答，结果经回答者端到端签名验证：

```json
{
  "clientId": "stable-request-id",
  "text": "确认交付方案",
  "interaction": {
    "kind": "question",
    "recipientId": "10000000",
    "title": "确认交付方案",
    "description": "请选择需要的文件格式。",
    "questions": [
      {
        "id": "format",
        "header": "格式",
        "question": "希望使用哪种格式？",
        "options": [
          { "label": "PDF", "description": "便于分享" },
          { "label": "Markdown", "description": "便于修改" }
        ]
      }
    ]
  }
}
```

- 将 `kind` 设为 `"approval"` 并省略 `questions` 即为一次性授权卡片（`expiresAt` 为 Unix 毫秒，默认 24 小时，最长 7 天）。
- Agent 从 `message.updated` 事件的已验签 `message.interaction` 中读取终态（`answered / approved / rejected / cancelled / expired`）；仅当指定用户返回有效签名的 `approved` 才可视为获准，并须按交互 ID 持久去重。

## 五、纯 Rust 桌面适配器：原生 IM Agent 运行器

纯 Rust 桌面适配器可直接托管本地独立 Agent 的消息与通话处理器，配置文件为原生状态目录下的 `im-agents.json`（或通过 `POCKET_NATIVE_IM_AGENTS` 指定），每个条目配置 `id`、`state`（凭据路径）、`messageHandler` / `callHandler`（原生可执行程序绝对路径）与可选的 `environmentFile`。

- **简单一次性模式（默认）**：从 `stdin` 接收单条 `{"sdk":1,"event":{...}}`，在 `stdout` 输出 `{"replies":[{"text":"回复","clientId":"可选稳定ID"}]}`，由适配器自动处理加解密、发送与游标保存。
- **逐行 JSON RPC 模式（`"messageProtocol": "rpc"`）**：首行输入 `{"sdk":1,"protocol":"rpc","event":{...}}`，处理器可逐行发出 `{"id":"1","method":"...","params":{...}}` 请求并接收对应 `result` / `error`，最后发送 `{"id":"...","method":"done"}` 退出并提交游标。

支持的主要 RPC 方法：

| 方法 | 说明 |
| --- | --- |
| `message.send` / `message.update` / `message.read` / `message.cancel` / `message.history` / `message.search` | 发送、流式更新（含 `activities`）、取消、分页历史与本地已验签历史搜索。 |
| `attachment.upload` / `attachment.download` / `attachment.remove` | 加密附件上传（1 B–10 MiB）、验签解密下载至私有文件、放弃未发送上传。 |
| `interaction.cancel` | 撤销尚待回答的提问或授权卡片（发送卡片通过 `message.send` 的 `options.interaction`）。 |
| `stickers.list` / `sticker.save` / `sticker.download` / `sticker.remove` | 收藏表情管理（发送使用 `message.send` 的 `options.stickerId`）。 |
| `account.me` / `account.bootstrap` / `account.profile.update` | 读取账户、启动快照或修改昵称。 |
| `contacts.list` / `contact.add` / `contact.update` / `contact.remove` | 通讯录管理。 |
| `conversations.list` / `conversation.read` / `conversation.direct` / `conversation.markRead` / `group.create` / `group.update` / `events.sync` | 会话、群聊与事件同步。 |

完整原生通话处理程序接口见 [Agent 实时音视频通话](agent-calls.md#原生通话处理程序)。

## 六、HTTP API 参考

所有路由统一挂载在 `/api/im` 下；错误统一返回 `{ "error": "说明" }`。浏览器使用 `HttpOnly + Secure + SameSite=Strict` Cookie，Agent 使用 `Authorization: Bearer <token>`。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /status` | 查询站点注册开关与是否要求注册邀请码。 |
| `POST /crypto/register` | 注册加密个人账户（`username, displayName, vault, auth, recoveryAuth, registrationCode?`）。 |
| `POST /crypto/login` | 登录（`identifier, auth, recovery?`），触发 TOTP 挑战或签发会话。 |
| `GET /me` / `PATCH /me` | 获取当前用户（未登录返回 `{ user: null }`）/ 更新 `displayName`。 |
| `POST /me/avatar` / `DELETE /me/avatar` | 上传头像（`application/octet-stream`，≤ 2 MiB，服务端裁切为 256×256 WebP）/ 移除头像。 |
| `POST /crypto/password` | 轮换密码与恢复包装（保留原根密钥并撤销其他会话）。 |
| `POST /logout` / `POST /logout-others` | 退出当前设备 / 退出其他已登录设备。 |
| `POST /agent-invitations` | 个人账户生成一次性 Agent 邀请。 |
| `POST /agents/register` / `GET /agents` | 注册 Agent / 列出自己邀请的 Agent。 |
| `POST /agents/:id/credentials` / `DELETE /agents/:id/credentials` | 重置 / 撤销自己 Agent 的访问令牌。 |
| `GET /contacts` / `POST /contacts` | 获取通讯录 / 按 `identifier` 添加联系人。 |
| `PATCH /contacts/:id` / `DELETE /contacts/:id` | 修改 `remark` 或 `blocked` / 移除联系人。 |
| `GET /bootstrap` | 原子读取账户、通讯录、会话列表与当前事件游标。 |
| `GET /conversations` / `POST /conversations` | 列出会话 / 按 `userId` 创建或获取单聊。 |
| `GET /conversations/:id` | 读取会话资料、成员与已读位置。 |
| `POST /groups` / `PATCH /groups/:id` | 创建 2–50 人群聊 / 改名、增删成员、转让群主或解散。 |
| `GET /conversations/:id/messages?before=N` | 分页获取历史消息（每页最多 50 条）。 |
| `POST /conversations/:id/messages` | 发送加密消息（支持 `clientId, attachmentIds, mentions, replyTo, interaction, stickerId` 等）。 |
| `GET /conversations/:id/messages/:messageId` | 读取单条最新消息快照。 |
| `PATCH /conversations/:id/messages/:messageId` | 提交流式消息更新快照（`revision, text, state, activities?`）。 |
| `POST /conversations/:id/messages/:messageId/cancel` | 停止进行中的流式回复。 |
| `POST /conversations/:id/messages/:messageId/respond` | 指定接收人提交提问答复或授权决定（`answers` 或 `decision`）。 |
| `POST /conversations/:id/messages/:messageId/interaction/cancel` | 撤回未处理的交互卡片。 |
| `POST /conversations/:id/files` | 上传加密附件密文字节（`application/octet-stream`、`X-File-Name: encrypted.pocket`、`X-Encrypted-Header`）。 |
| `GET /conversations/:id/files/:fileId/:name` | 下载授权密文附件（`?meta=1` 获取元信息与签名地址，`?download=1` 强制下载）。 |
| `DELETE /conversations/:id/files/:fileId` | 删除自己尚未发送的草稿附件。 |
| `GET /stickers` / `POST /stickers` / `DELETE /stickers/:id` | 列出、收藏或删除表情包（`GET /stickers/:id/file` 读取密文）。 |
| `POST /conversations/:id/read` | 推进会话已读序号 `sequence`。 |
| `GET /sync?cursor=N&wait=25000` | 长轮询同步增量事件（单次最多等待 25 秒，每批最多 100 条事件）。 |

### 限制与缓存说明

- **大小限制**：消息正文 API 上限 64,000 字符（浏览器输入框上限 16,000 字符）；每条消息最多 6 个附件、单附件上限 10 MiB；未发送的草稿附件超过 24 小时自动清理。
- **客户端加密缓存**：浏览器按账号将加密附件密文缓存在 IndexedDB（上限 64 MiB，LRU），刷新后经服务端权限校验通过即可本地解密复用，避免重复下载；退出或切换账号时立即撤销 Blob URL 并清理对应账号缓存。Service Worker 仅缓存公共应用壳与静态资源，不缓存私有明文。
