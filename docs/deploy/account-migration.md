# 一次性账号加密迁移

正式版服务仅接受端到端加密格式的账号、消息与附件，不包含明文运行兼容开关。如果你的旧版部署中仍有历史明文消息库，可通过本工具一次性迁移至加密格式，完整保留原有 UID、用户名、联系人、群聊、消息序号/时间/正文、引用回复、交互授权结果、附件与表情收藏。

迁移工具独立于正式服务，开发态运行 `npm run im:migrate -- ...`，生产构建可直接运行 `node dist/server/account-encryption-migrate.js ...`（参数相同）。

> **安全原则**：`export` / `apply` / `commit` 在停服的中继服务器运行；`prepare` / `encrypt` 在各账号拥有者自己的可信设备运行。切勿将任何人的私钥、新密码、恢复码或 `private-state.json` 交给服务器或其他人。

## 1. 停服并按账号导出

保持中继服务停服直至整个迁移提交成功，在受限目录（输出默认 `0600`）执行导出：

```bash
npm run im:migrate -- export \
  --database /private/messaging.sqlite \
  --out /private/migration-jobs \
  --origin https://app.example.com \
  --adapter /private/media-adapter.mjs
```

- 未使用外部对象存储时省略 `--adapter`。
- 工具会校验所有原附件的大小与哈希，若缺失或损坏会立即停止。
- 将 `migration-jobs/<UID>.json` 通过受控私密渠道分别交给对应账号拥有者（Agent 账号由其拥有者代为处理）。

## 2. 各账号在自己设备上生成加密身份

每个账号拥有者在自己的设备上执行：

```bash
npm run im:migrate -- prepare \
  --job /private/my-job.json \
  --state /private/private-state.json \
  --out /private/enrollment.json
```

- 个人账号需通过终端设置**不同于旧密码的新密码**；生成的 256 位恢复码保存在本地 `private-state.json` 中，请另行妥善离线备份。
- Agent 账号可附加 `--agent-state /private/previous-agent.json` 以保留原令牌与服务地址，迁移完成后将新的 `private-state.json` 作为 Agent CLI 的 `--state`。
- 仅将 `enrollment.json`（含公钥、加密私钥包与登录证明，不含解密私钥与恢复码）返回迁移操作员。

## 3. 生成公钥目录并由各自加密历史数据

操作员汇总全部 `enrollment.json` 路径写入数组文件 `enrollments.json` 后生成公钥目录：

```bash
npm run im:migrate -- directory \
  --enrollments /private/enrollments.json \
  --out /private/public-directory.json
```

将公钥目录经可信渠道分发给每个账号拥有者，各自在自己设备上执行本地加密与自检签名：

```bash
npm run im:migrate -- encrypt \
  --job /private/my-job.json \
  --state /private/private-state.json \
  --directory /private/public-directory.json \
  --out /private/encrypted-part.json
```

仅将签名后的密文包 `encrypted-part.json` 返回操作员。

## 4. 校验并生成密文候选库

操作员汇总所有 `encrypted-part.json` 路径写入 `parts.json`，在原数据库同一文件系统生成候选数据库：

```bash
npm run im:migrate -- apply \
  --database /private/messaging.sqlite \
  --parts /private/parts.json \
  --out /private/messaging.encrypted.sqlite \
  --receipt /private/migration-receipt.json
```

工具严格核对每个账号恰好一份包、快照一致性、签名完整性及记录完整性；通过后会清除候选库的空闲明文页与 WAL，失败时原数据库保持不动。

## 5. 原子切换并清理旧明文对象

```bash
npm run im:migrate -- commit \
  --database /private/messaging.sqlite \
  --receipt /private/migration-receipt.json \
  --origin https://app.example.com \
  --adapter /private/media-adapter.mjs
```

`commit` 复核源库与候选库未被修改后执行原子替换，并删除不再被引用的旧明文媒体对象（使用对象存储时适配器须实现 `remove()`）。完成后即可启动新版服务，个人账号使用新密码登录，并及时清理临时导出文件与明文旧备份。
