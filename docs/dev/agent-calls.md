# Agent 实时音视频通话

在个人用户与自己 Agent 的一对一聊天中，标题栏提供「语音」和「视频」入口，支持基于 WebRTC 的双向实时音视频通话。子虚亭负责端到端加密信令、通话生命周期与 ICE 协商；语音识别、推理、语音合成与视频理解由 Agent 自身的媒体处理器实现。

## 一、接入现有 Agent（Node 处理器）

AI 助手接入时可直接加载仓库内置技能 [`skills/agent-space-calls/SKILL.md`](../../skills/agent-space-calls/SKILL.md)。已有文字 Agent 应复用其原有的加密状态文件，另起一个接听进程：

```bash
npm run im:call -- --state /private/my-agent.json --handler /private/media-handler.mjs
```

媒体处理器导出真实支持的能力与 `onCall` 回调：

```js
export const capabilities = { audio: true, video: true };

export async function onCall({ call, peer, signal }) {
  // peer 为 werift RTCPeerConnection，请尽快注册轨道监听并返回清理函数。
  // peer.onTrack.subscribe(track => ...)：接收用户侧 RTP 音视频轨道。
  // peer.addTrack(outputTrack)：推送 Agent 生成的音视频轨道。
  // 返回 false 表示拒接；返回清理函数在挂断或断开时释放模型与媒体资源。
  return () => {
    /* release resources */
  };
}
```

也可以基于其他 WebRTC 库，直接复用 `src/client/calls.ts` 中的 `AgentCallsClient` 实现自定义接听端。

## 二、原生通话处理程序

纯 Rust 桌面适配器可通过 `im-agents.json` 中的 `callHandler` 托管原生可执行媒体处理器，或单独运行接听进程：

```bash
agent-space-native --im-call --state /private/my-agent.json --handler /private/native-media-handler
```

支持可选参数 `--environment-file` 注入私有环境文件；进程退出时自动挂断并撤销在线接听声明。通信采用带 `Content-Length` 帧头的标准输入/输出 **JSON-RPC 2.0**（响应须在顶层回显 `id` 与请求的 `params.generation`）：

| 方法 | 参数与返回值 |
| --- | --- |
| `call/check` | 接收 `{ sdk: 1 }`，返回 `{ sdk: 1, audio: true, video?: boolean }`。 |
| `call/open` | 接收 `{ call, iceServers }`，初始化媒体上下文并返回 `{ accepted: boolean }`。 |
| `call/signal` | 接收 `{ signal }`，应用已解密的 WebRTC offer 或 ICE candidate。 |
| `call/poll` | 返回待发送的信令列表与连接状态 `{ signals?: CallPayload[], connected?: boolean, failed?: boolean }`。 |
| `call/close` | 接收 `{ reason }`，关闭当前媒体连接并返回 `{}`（无活动连接时也应成功）。 |

适配器会在 offer 到达前暂存 ICE candidate，并对处理程序输出的 answer 与候选项执行端到端加密签名；收到输入 EOF 时处理程序须释放全部媒体资源。参考夹具见 `desktop/native/examples/native-im-fixture.rs`。

## 三、信令协议与生命周期

所有接口挂载在 `/api/im` 下，沿用账号会话 Cookie 或 Agent Bearer 令牌。SDP 与 ICE candidate 必须经 `AgentCallsClient` 端到端加密签名（上下文 `call:<callId>:<signalId>`，精确限定通话双方），不会进入普通聊天记录。

| 接口 | 用途 |
| --- | --- |
| `PUT /calls/presence` | Agent 声明 `{ video, available }`（有效 90 秒，建议每 30 秒续期）。 |
| `GET /conversations/:id/call-capabilities` | 查询会话中 Agent 的在线接听能力。 |
| `GET /calls/ice` | 获取当前实例的 STUN/TURN ICE 配置及短期 TURN 凭据。 |
| `POST /conversations/:id/calls` | 发起通话 `{ id: UUID, mode: "audio" \| "video" }`（同 ID 幂等）。 |
| `GET /calls` | 查询当前账号未结束的通话（Agent 可每秒轮询）。 |
| `PATCH /calls/:id` | `{ action: "accept" \| "heartbeat" \| "end", reason? }`（仅被叫方可接听）。 |
| `POST /calls/:id/signals` | 提交加密信令 `{ id: UUID, encrypted }`（同 ID 与密文幂等）。 |
| `GET /calls/:id?after=N` | 拉取通话状态、增量信令与游标。 |

- **超时与并发**：双方每 20 秒发送心跳；响铃 45 秒未接听、任一方 90 秒无心跳或单次通话达 1 小时将自动结束；单方通话期间不接受并行呼叫。
- **隐私与安全**：WebRTC 媒体流使用 DTLS-SRTP，不经聊天附件存储也不在服务端录制；挂断后立即删除暂存信令，已结束通话的元数据最多保留 1 天。撤销 Agent 凭据会立即挂断通话并清除在线能力。

## 四、跨网络 STUN / TURN 配置

浏览器与参考接听端采用 ICE `all` 策略，优先直连同时准备 TURN 候选回退，接通后界面会显示当前为「直连」或「中继」。在 Node 环境文件或 Cloudflare Worker `vars` / `secrets` 中配置：

```dotenv
POCKET_IM_CALL_STUN_URLS=stun:stun.example.com:3478
POCKET_IM_CALL_TURN_URLS=turn:turn.example.com:3478,turns:turn.example.com:5349
# 仅配置在服务端，用于签发 TURN REST 短期凭据，不暴露给浏览器
POCKET_IM_CALL_TURN_SECRET=<私有共享密钥>
```

多个地址用逗号分隔；跨 NAT 或蜂窝移动网络场景必须配置可达的 STUN/TURN 服务。TURN 媒体流量不计入聊天附件配额。通话功能始终限定在个人用户与其名下 Agent 之间。
