# 对象存储扩展

工作台附件优先读取客户端本地缓存，其次通过设备级 WebRTC 直连传输，通常无需配置对象存储。当无法建立直连时，8 MiB 以内的文件自动通过加密 WSS 中继传输；对于更大的附件，可选择性配置私有对象存储作为**密文临时回退通道**（不可用时仍会自动回退 WSS）。

私有对象存储仅接收随机对象名和 AES-256-GCM 密文块（`application/octet-stream`），不接收原始文件名、明文哈希或解密密钥。

## 一、纯 Rust 桌面适配器：原生对象存储插件

纯 Rust 桌面适配器支持通过 `product: "object-storage"` 的独立原生插件接入任意自定义私有对象存储。

### 安装与配置

使用 `agent-space-native --adapter install <插件目录>` 安装包含 `adapter.json` 与可执行文件的插件包，然后在原生状态目录的 `transport.env` 中启用：

```dotenv
POCKET_NATIVE_STORAGE_PLUGIN=my-media-storage@1.0.0
POCKET_NATIVE_STORAGE_PLUGIN_CONFIG=/absolute/path/to/private-storage.json
POCKET_MEDIA_PREFIX=fable-pavilion
```

- `POCKET_NATIVE_STORAGE_PLUGIN_CONFIG` 可省略；存在时应为当前用户私有的 JSON 文件，其内容仅通过本机插件初始化管道传给该插件。
- 更换插件版本时更新上述配置并重启适配器。

### 插件 JSON-RPC 协议

对象存储插件复用 [原生插件协议](../dev/adapter-plugins.md#原生插件协议) 的 `Content-Length` + JSON-RPC 2.0 帧格式。`adapter/initialize` 的 `config` 包含 `purpose: "media"`、服务 `origin` 与 `settings`，插件应在初始化时核实目标存储桶权限。

| 方法 | 参数与返回值 |
| --- | --- |
| `storage/info` | 返回 `{ version: 1, visibility: "private", uploadOrigins: [...], remove?: true }`。`uploadOrigins` 为精确 HTTPS origin 列表。 |
| `storage/createUpload` | 接收 `key`、密文字节数 `size`、过期时间戳 `expiresAt`（Unix 毫秒），返回下方定义的浏览器直传授权（multipart POST 或 raw PUT）。 |
| `storage/downloadUrl` | 接收 `key` 与 `expiresAt`，返回单对象短期 HTTPS 签名下载 URL 字符串。 |
| `storage/putFile` | 接收 `key`、临时密文文件路径 `file`、`contentType`、`cacheControl`、`allowedOrigin`、`expiresAt`，返回 `"created"` 或 `"exists"`；调用完成后由适配器清理临时文件。 |
| `storage/remove` | 当 `storage/info` 声明 `remove: true` 时调用，接收 `key`，删除成功或对象不存在时返回 `{ ok: true }`。 |

完整参考夹具见仓库中的 `desktop/native/examples/native-storage-fixture.rs`。

## 二、Node 服务端 / 媒体存储适配器接口

在 VPS / Node 部署中，还可通过本地 JavaScript 模块为持久化消息附件（`POCKET_IM_MEDIA_ADAPTER`）或公开静态资源发布（`POCKET_ASSET_ADAPTER`）接入私有对象存储：

```dotenv
# 持久化私有消息附件存储适配器（服务端加载）
POCKET_IM_MEDIA_ADAPTER=/absolute/path/to/private-media-adapter.mjs
POCKET_IM_MEDIA_ORIGIN=https://private-objects.example.com

# 可选：桌面媒体/公开资源适配器
POCKET_MEDIA_ADAPTER=/absolute/path/to/media-adapter.mjs
POCKET_ASSET_ADAPTER=/absolute/path/to/asset-adapter.mjs
```

模块默认导出工厂函数 `({ purpose, origin }) => adapter`（`purpose` 为 `"media"` 或 `"assets"`），在初始化时须检查远端存储桶的实际公开/私有权限，权限不匹配时应拒绝启动。接口类型见 [src/server/object-storage.ts](../../src/server/object-storage.ts) 与 [src/shared/storage.ts](../../src/shared/storage.ts)：

| 成员 | 约定 |
| --- | --- |
| `version` | 固定为 `1`。 |
| `visibility` | 私有附件为 `"private"`，静态资源为 `"public"`。 |
| `uploadOrigins` | 浏览器直传使用的精确 HTTPS origin 列表（不含通配符、路径或凭据）。 |
| `putFile(params)` | 上传新对象，返回 `"created"` 或 `"exists"`。 |
| `downloadUrl(key, expiresAt)` | 返回单对象短期 HTTPS 签名下载链接。 |
| `createUpload({ key, size, expiresAt })` | 返回绑定单对象、精确密文长度与有效期的临时直传授权，不得暴露长期密钥。 |
| `remove(key)` | 生产环境强烈建议实现，用于消费后即时清理及用户手动清理附件。 |

### 浏览器直传授权格式

`createUpload` 支持以下两种返回格式之一：

```ts
// 方式 A：multipart POST
{
  url: 'https://upload.example.com',
  method: 'POST',
  encoding: 'multipart',
  fields: { policy: '<short-lived-object-policy>' },
  fileField: 'file'
}

// 方式 B：原始字节 PUT
{
  url: 'https://upload.example.com/object?grant=<short-lived-grant>',
  method: 'PUT',
  encoding: 'raw',
  headers: { 'Content-Type': 'application/octet-stream' }
}
```

## 三、CORS、CSP 与生命周期要求

1. **CSP 与 CORS**：将所有直传与下载域名（精确 HTTPS origin）加入云端 `POCKET_UPLOAD_ORIGINS`（或消息存储的 `POCKET_IM_MEDIA_ORIGIN`）；对象存储侧的 CORS 规则须允许应用精确 origin、`Range` 请求头，并暴露 `Content-Range`。
2. **工作台临时密文生命周期**：工作台加密附件使用 `private-encrypted-v2/` 前缀，单对象由 1 MiB 认证加密块分组而成。消费完成后适配器会主动删除对象；同时请在存储桶侧为该前缀配置 **24 小时自动过期删除策略**，以兜底电脑离线期间遗留的临时对象。
3. **即时消息持久附件**：即时消息附件使用独立前缀（如 `im-media-v1/`），**不要**对该前缀配置 24 小时自动删除。

## 四、验证与旧对象清理

运行隔离存储契约测试（仅创建可自动删除的合成密文对象，不触碰真实会话）：

```bash
npm run test:storage
```

如需盘点早期版本遗留的明文对象，可运行运维盘点脚本（默认只读，仅在显式附加 `--clean-verified` 且本地副本哈希一致时才会删除，并始终排除公开静态资源前缀）：

```bash
node --import ./scripts/env.mjs --import tsx scripts/inventory-legacy-storage.ts
```
