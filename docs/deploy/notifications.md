# 推送通知配置

子虚亭支持在用户未停留在当前会话视图时，通过系统通知提醒新助手消息与实时来电。未配置推送参数时，站内实时消息与来电功能不受影响。

- **网页端（Web / PWA）**：使用标准 Web Push（VAPID）。iOS / iPadOS 需先将站点「添加到主屏幕」后再开启通知。
- **Android 客户端**：使用 UnifiedPush，需在手机上安装并启用受站点允许的分发器（例如使用 `https://ntfy.sh` 的 ntfy Android）。
- **隐私保护**：网页通知使用 Web Push 端到端加密，Android 通知使用每台设备独立的 AES-GCM 密钥；推送载荷仅包含事件类型、标识与有效期，不包含明文聊天正文。

## 服务端配置

VPS/Node 与 Cloudflare 部署共用相同的环境变量与事件队列。

### 1. 生成 VAPID 密钥对

每个独立部署只需生成一套长期使用的 VAPID 密钥，并将私钥保存在私有环境或密钥管理服务中：

```bash
umask 077
node --input-type=module - <<'JS' > web-push-private.json
import { createECDH } from 'node:crypto';
const key = createECDH('prime256v1');
key.generateKeys();
console.log(JSON.stringify({
  POCKET_IM_PUSH_WEB_PUBLIC_KEY: key.getPublicKey().toString('base64url'),
  POCKET_IM_PUSH_WEB_PRIVATE_KEY: key.getPrivateKey().toString('base64url'),
  POCKET_IM_PUSH_WEB_SUBJECT: 'https://app.example.com',
}));
JS
```

### 2. 注入运行环境

将以下变量配置到 Node 私有环境文件或 Cloudflare Worker 的 `vars` / `secrets` 中（私钥务必作为 secret 管理）：

| 变量 | 说明 |
| --- | --- |
| `POCKET_IM_PUSH_WEB_PUBLIC_KEY` | VAPID 公钥（base64url）。 |
| `POCKET_IM_PUSH_WEB_PRIVATE_KEY` | VAPID 私钥（base64url，仅服务端可见）。 |
| `POCKET_IM_PUSH_WEB_SUBJECT` | 站点的 HTTPS 联系地址或 `mailto:` 地址（如 `https://app.example.com`）。 |
| `POCKET_IM_PUSH_ANDROID_ORIGINS` | 允许的 Android UnifiedPush 分发器精确 HTTPS origin，多个用逗号分隔（例如 `https://ntfy.sh`）。 |

## 用户开启与撤销

1. 用户登录后，前往「我的 → 设置 → 通知设置」开启本机通知并授予系统权限。
2. Android 端收到来电通知时，可直接从通知栏选择接听或拒绝；任一设备接听、挂断或来电过期后，其他已登录设备会自动清除通知。
3. 退出登录或移除设备时，服务端会自动撤销对应设备的推送订阅。

如需让已接入的 Agent 主动向指定个人会话发起语音或视频来电，可在启动通话监听器时传入 `--call` 参数：

```bash
npm run im:call -- --state /private/my-agent.json --handler /private/media-handler.mjs \
  --call <CONVERSATION_UUID> --mode video
```
