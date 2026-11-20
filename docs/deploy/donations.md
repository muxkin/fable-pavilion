# 支持项目页面配置

自托管站点可在「我的 → 设置 → 支持项目」展示可选的公开赞赏渠道（如微信赞赏码与爱发电主页）。支持完全自愿，不改变账户功能或配额，也不会在聊天或工作台弹出打扰提示。

## 部署参数配置

源码仓库默认不内置任何个人赞赏信息（默认输出空配置 `{}`）。自部署时，请将赞赏配置文件与收款码图片保存在 Git 忽略的私有目录（例如 `local/support/`），并在构建前端时通过部署参数注入：

```dotenv
POCKET_SUPPORT_CONFIG=/absolute/path/to/private/support.json
POCKET_SUPPORT_QR_FILE=/absolute/path/to/private/wechat-reward.png
```

`support.json` 格式示例：

```json
{
  "wechat": {
    "recipient": "公开的赞赏码名称",
    "qr": "/support/wechat-reward.png",
    "previewCrop": { "x": 0.248, "y": 0.124, "size": 0.504 }
  },
  "platform": {
    "name": "爱发电",
    "creator": "公开的创作者昵称",
    "url": "https://afdian.com/a/your-name",
    "enabled": true
  }
}
```

- 两个渠道均可独立省略；未设置 `POCKET_SUPPORT_CONFIG` 时，页面显示「支持方式正在准备中」。
- **微信赞赏码**：`wechat.qr` 须为 `/support/<文件名>` 形式的同源路径，`POCKET_SUPPORT_QR_FILE` 指向的原图会在构建时原样输出到该路径（不重新压缩损坏码点）；可选 `previewCrop` 按比例裁剪预览可见区域。触屏设备自动提示长按图片保存扫码，桌面端直接展示。
- **外部赞助平台**：`url` 必须是不含凭据的绝对 HTTPS 地址，`enabled: false` 时显示准备中状态。
- 所有字段均为公开静态配置，**切勿**写入商户密钥、平台 API Token 或任何私密凭据。

Node/VPS（`npm run build:web`）与 Cloudflare（`npm run build:cf`，可通过 `POCKET_CF_ENV_FILE` 或环境变量注入）共用同一套构建注入机制，重新构建发布后生效（浏览器按 `no-cache` 读取）。
