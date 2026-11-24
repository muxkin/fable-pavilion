# 桌面适配器安装与配置

子虚亭桌面适配器（`agent-space-native`）采用纯 Rust 实现，无须安装 Node.js 或 Python。程序在系统托盘中无窗口静默运行，仅在本机回环地址提供管理界面，通过独立的 Rust 插件进程连接本机已运行的 **Codex**、**DSH** 与 **Antigravity**，并通过 Noise 端到端加密通道与手机和网页通信。

## 下载与安装

你可以从所在站点的「我的 → 设置 → 电脑适配器」或 [GitHub Releases](https://github.com/muxkin/fable-pavilion/releases) 获取当前版本的安装包、便携包与 `SHA256SUMS` 校验文件。

| 平台 | 产物形态 | 安装与启动方式 |
| --- | --- | --- |
| Windows x64 | `*-windows-x64-setup.exe` | 当前用户安装，安装后从开始菜单启动；重装或卸载前请先从托盘退出。 |
| macOS（Apple Silicon / Intel） | `*-macos-arm64.dmg` / `*-macos-x64.dmg` | 拖入 `Applications` 后打开（构建目标为 macOS 14+）。 |
| Linux x64 DEB | `*-linux-x64.deb` | Debian/Ubuntu 系执行 `sudo apt install ./<安装包>.deb`（要求 glibc 2.35+）。 |
| Linux x64 musl 托盘便携包 | `*-linux-x64-musl-desktop.tar.zst` | 静态链接；解压至当前用户可写目录（如 `~/Applications/fable-pavilion`），保持主程序与 `official-plugins` 相对位置后运行 `./agent-space-native`。 |
| Linux x64 无头网关 | `*-linux-x64-musl.tar.xz` | 适用于无桌面环境的服务器，解压后运行 `./agent-space-native --headless`（首次配对可加 `--print-pair`）。 |

> **签名提示**：通用预览安装包中，Windows 安装包暂无发布者代码签名，macOS 应用使用本地临时签名（ad-hoc）而未经 Apple 公证。建议核对发布页提供的 SHA-256 校验值；启用发布公钥的安装版仍会对后续自动更新包执行 Ed25519 验签。

安装版与便携版共用同一份原生状态目录。切换安装形式前请先从托盘退出旧进程并关闭其自启动，再在新安装中重新开启自启动。卸载程序不会删除你的设备身份、配对记录和本地附件数据。

## 首次连接与账号授权

1. 安装后从应用菜单启动「子虚亭适配器」（英文系统显示为 `Fable Pavilion Adapter`）。
2. 程序会在默认浏览器打开本机管理页；如果浏览器未自动打开，可在终端运行：
   ```bash
   agent-space-native --print-settings
   ```
3. 通用安装包默认指向官方站点，自托管用户可在管理页切换为自己的 HTTPS 服务地址。
4. 点击「登录并授权这台电脑」，在网页端登录你的账号并确认授权。完成后，电脑会自动加密配对并同步到你的账号；其他设备登录同一账号后即可在「工作台」看到这台电脑。
5. 如果需要手动配对或接入旧服务，可在管理页「其他连接方式」中使用接入密钥或生成一次性手机配对二维码。

关闭浏览器标签页后，适配器会继续在托盘运行；桌面版首次启动默认开启「登录后自动启动」，可在管理页中随时关闭或重新开启。

## 离线秘钥簿

管理页内置「秘钥簿」，用于在本机安全保存已授权账号的 **6 位登录动态码（TOTP）** 与 **账号恢复码**：

- **离线可用**：查看已保存条目不需要联网或登录网站，动态码由适配器在本机按标准 RFC 6238 每 30 秒生成（请保持电脑系统时间准确）。
- **默认掩码保护**：凭据默认隐藏，点击「查看」后才显示，切换页面或后台时自动重新隐藏；查看接口仅对携带本机启动凭据的回环管理页开放，不会通过远程接口暴露。
- **本机加密存储**：三端共用本机加密存储，优先将加密密钥保存在操作系统凭据管理器（Keychain / Credential Manager / Secret Service）；若系统无可用凭据库，则使用受当前用户文件权限保护的独立随机密钥文件，账号凭据文件始终为密文。备份状态目录时请同时保留 `account-security-v1.json` 与 `account-security-key-*.bin`。
- **自动同步与手动管理**：在网站确认「授权这台电脑」后，适配器会自动导入并同步当前账号版本的动态码密钥与加密恢复码。对于此前从未同步过原文的历史恢复码，可在「管理秘钥簿」中手动补录。移除本机条目不会影响云端账号或电脑授权。

## 管理已接入的 Agent 实例

安装包默认附带官方 **Codex**、**DSH** 与 **Antigravity** 三款原生 Rust 插件，首次启动时会自动校验并登记到本地私有注册表：

- **Codex**：自动发现本机 Codex 状态目录与桌面端点（默认实例 ID 为 `codex-local`）。可通过 `POCKET_NATIVE_CODEX_HOME`、`CODEX_HOME`、`POCKET_NATIVE_CODEX_SOCKET`、`POCKET_NATIVE_CODEX_APP_TOOLS`、`POCKET_NATIVE_CODEX_CLI` 等环境变量按需覆盖；如需只读模式，可设置 `POCKET_NATIVE_READ_ONLY=1`。
- 旧版会话同步接口不可用时，支持桌面工具接口的 **Codex** 可以向历史会话发送消息并在运行中追加；当本机 Codex 同时提供共享本地 App Server 控制套接字（`app-server-control.sock`）时，会话权限切换、随消息/新会话选择技能与插件、原生图片与中断均可继续使用。若未连接共享 App Server，则仅保留桌面工具文本与文件引用收发。
- 在 Linux 和 macOS 上，写入 **Codex 长期目标**需要本机 Codex 启用目标功能，且桌面应用通过共享的本地 App Server 守护进程加载会话。支持共享模式的桌面版本可在启动时设置 `CODEX_APP_SERVER_USE_LOCAL_DAEMON=1`。桌面提供目标快照时，工作台可以只读查看目标内容和状态。
- **Codex Voice**：在工作台打开 Codex 会话后，可通过标题栏麦克风图标发起实时语音通话（需本机 Codex 账号已开通原生语音功能，且手机端通过 HTTPS 访问）。语音通话基于只读独立分支运行，结束后可查看保存的转写。
- **Antigravity**：当本机数据目录（默认 `~/.gemini/antigravity`，可用 `POCKET_NATIVE_ANTIGRAVITY_HOME` 覆盖）存在 `daemon` 时，适配器会自动发现并添加 `antigravity-local` 实例；设置 `POCKET_NATIVE_ANTIGRAVITY=0` 可关闭自动发现。
- **DSH 与多实例配置**：可在网页端「我的 → 设置 → 插件管理」、桌面适配器本机设置页「插件」标签，或状态目录的 `instances.json`（也可通过 `POCKET_ADAPTERS_FILE` 指定路径）管理多个 Codex、DSH、Antigravity 或第三方原生插件实例。完整配置格式及插件在线升级/回滚命令见 [适配器插件与开发](../dev/adapter-plugins.md)。
- **内置终端插件（默认禁用）**：适配器内置纯 Rust 跨平台终端插件（Linux/macOS 使用 POSIX PTY，Windows 使用原生 ConPTY，支持 PowerShell 7 / Windows PowerShell / CMD / Git Bash / WSL）。默认关闭，需在网页端「我的 → 设置 → 插件管理」或桌面本机设置页「插件」标签手动开启。开启后可在工作台打开交互式终端，支持多标签会话、lrzsz（`rz`/`sz`）、trzsz（`trz`/`tsz`）、Sixel / iTerm2 / Kitty 内联图片显示、剪贴板与拖拽传图、OSC 52 剪贴板以及可选的 X11 / Wayland / 本机回环端口转发。

### 修改实例外观

除在网页工作台直接编辑外，也可以在本机使用命令行修改实例显示名称、说明和图标：

```bash
agent-space-native --instance list
agent-space-native --instance show codex-local
agent-space-native --instance set codex-local --name "工作助手" --emoji "🦄"
agent-space-native --instance reset codex-local
```

## 自动更新

- 安装版默认内置发布公钥（`desktop/native/update-release.pub`），在「设置 → 自动更新」可随时开关更新、手动检查或填写独立 HTTPS 更新源（留空时自动跟随当前服务地址的 `/downloads/desktop/native/rust/<平台>/<架构>/latest.json`）。
- 程序启动后及持续运行期间每 15 分钟检查一次更新，严格校验签名清单、平台架构、文件长度与 SHA-512。
- 存在正在进行的写入、附件上传、独立 Agent 任务或实时音视频通话时，更新会自动延后，待空闲后安全交接给独立的 Rust 安装进程，不会中断正在执行的桌面 Agent 任务。
- 可通过启动环境变量 `POCKET_NATIVE_UPDATES=0` 禁用自动更新，或通过 `POCKET_NATIVE_UPDATE_BASE_URL` 预设初始更新源。无头网关包通过替换解压目录手动升级。

## 状态目录与从旧版本迁移

默认状态目录位于系统用户数据目录下的 `agent-space-native-preview`，也可以通过 `POCKET_NATIVE_STATE_DIR` 指定独立私有目录（方便隔离试用，避免同一主机身份同时连接中继）。

如果需要从早期的 Node 网关或混合安装版迁移设备身份、配对、操作记录、实例配置与上传索引：

1. 先正常退出旧版进程，并关闭旧版的开机自启动。
2. 确保目标状态目录尚未创建，执行：
   ```bash
   agent-space-native --import-node-state /absolute/path/to/old-state --origin https://app.example.com
   ```
3. 历史附件与旧回执会继续按原路径只读访问，请保留旧目录以便访问历史附件。
4. 迁移完成后，请勿再同时启动旧版网关。

## 传输与私有存储设置

适配器默认启用 WebRTC 直连以降低中继流量并加速大附件传输。如需调整网络传输行为，可在原生状态目录的 `transport.env` 中配置：

- `POCKET_NATIVE_P2P=0`：禁用 WebRTC 直连，仅使用加密 WSS 中继。
- `POCKET_STUN_URLS=stun:stun.example.com:3478`：自定义 STUN 服务器列表（逗号分隔）。
- 如需为超大附件配置自定义私有对象存储回退，请参见 [对象存储扩展](../deploy/storage.md)。
