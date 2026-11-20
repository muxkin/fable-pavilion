# 桌面包构建与更新分发

如果你自行托管子虚亭站点，可以为你的站点构建预设默认服务地址的纯 Rust 桌面适配器安装包，并通过自己的站点（Cloudflare R2 或 VPS 本地目录）向用户分发签名更新包，无需依赖第三方更新服务器。

## 1. 本地源码构建纯 Rust 适配器

环境要求：Rust 稳定版工具链（版本见 `desktop/native/rust-toolchain.toml`）。

```bash
cd desktop/native
cargo build --release --locked
```

构建三款官方原生插件：

```bash
cd desktop/native
cargo build --release --locked --no-default-features --features official-plugins \
  --bin agent-space-adapter-codex \
  --bin agent-space-adapter-dsh \
  --bin agent-space-adapter-antigravity
```

- **指定自建站点默认地址**：构建前可通过 `POCKET_NATIVE_DEFAULT_ORIGIN=https://app.example.com` 注入首次启动时的默认服务地址（纯 HTTPS origin，不含路径、尾斜杠或凭据）。已保存或迁移的地址始终优先于构建预设值。
- **Linux 静态链接（musl）**：可使用 `--target x86_64-unknown-linux-musl` 构建无动态库依赖的网关和静态托盘包（交叉构建需要对应 musl C 工具链以编译 SQLite 等原生依赖）。
- **独立源码归档**：GitHub Release 附带的 `AgentSpace-Native-<版本>-source.tar.gz` 为自包含 Cargo 工作区，解压后直接执行 `cargo build --release --locked` 即可构建适配器与官方插件。

## 2. 签名更新源与发布目录结构

桌面适配器的自动更新公钥位于 `desktop/native/update-release.pub`（Ed25519）；自托管发行若需使用自己的更新签名密钥，请将私钥保存在受控发布机中，并在构建前端时通过 `POCKET_DESKTOP_UPDATE_PUB_FILE=/absolute/path/to/update-release.pub` 注入对应公钥（构建桌面端时对应替换该公钥文件）。若需自定义或隐藏下载页的源码归档链接，可在前端构建时设置 `POCKET_RELEASE_REPO`（设为 `none` 隐藏）。

安装版默认从当前服务地址的以下路径检查更新清单：

```text
/downloads/desktop/native/rust/<平台>/<架构>/latest.json
```

支持的五个平台通道为：`linux/x64`（DEB）、`linux/x64-musl`（静态托盘便携包）、`win32/x64`、`darwin/arm64`、`darwin/x64`。

### 发布到 Cloudflare R2

Cloudflare Worker 内置 `/downloads/desktop/` 下载契约，支持 `HEAD`、`ETag` 与单区间 `Range` 断点续传，只暴露发布清单与带版本号的安装包，不暴露消息附件。默认复用 `IM_MEDIA` R2 Bucket 的 `desktop-releases/` 前缀，也可通过独立 `DESKTOP_RELEASES` binding 隔离。

```bash
node scripts/desktop/publish.mjs \
  --native-version <版本号> --rust-native \
  --config /path/to/private/wrangler.jsonc \
  --bucket <你的R2-Bucket名称> \
  --origin https://app.example.com \
  --platform linux --arch x64
```

- 无平台代码签名证书的 Windows / macOS 预览构建需附加 `--release-key-only`（仅使用发布密钥对更新清单验签）。
- 发布脚本会先校验文件长度与 SHA-512，先上传不可变安装包并回读校验，最后才原子更新 `latest.json` 与网页下载索引；重发需递增版本号。

### 发布到 VPS / Node

VPS 无需 Cloudflare 或 R2，可直接发布到本地持久化目录：

```bash
node scripts/desktop/publish.mjs \
  --native-version <版本号> --rust-native \
  --directory /path/to/installers \
  --output /srv/fable-releases \
  --platform linux --arch x64
```

并在 Node 服务端私有环境文件中指定：

```dotenv
POCKET_DESKTOP_RELEASE_ROOT=/srv/fable-releases
```

### 可选：对象存储直发跳转

若希望将大安装包下载流量卸载至独立公开下载域名，可在服务端配置：

```dotenv
POCKET_DESKTOP_DOWNLOAD_BASE=https://downloads.example.com/site/
```

将已校验的安装包同步至该地址下的 `desktop-releases/` 后，网页下载页与支持直发的更新器会通过 307 跳转至该地址下载，同时继续按签名清单核对长度与 SHA-512。

## 3. 统一云端发行校验（可选）

对于需要严格核对源码提交、确保多节点或多运行时（Node + Cloudflare）运行完全一致编译产物的部署流程，可使用内置发行脚本 `scripts/cloud-release.mjs`：

```bash
# 1. 在干净工作树中针对指定 40 位提交生成不可变发行目录与清单
node scripts/cloud-release.mjs prepare \
  --expected-commit <完整40位提交SHA> \
  --out /tmp/fable-release \
  --cf-config /path/to/private/wrangler.jsonc

# 2. 上传前复核所有后端与前端产物未被篡改
node scripts/cloud-release.mjs verify \
  --expected-commit <同一个提交SHA> \
  --manifest /tmp/fable-release/release-manifest.json \
  --root /tmp/fable-release

# 3. 上线后回读服务端 /api/release 与静态 /release.json 核对版本一致性
node scripts/cloud-release.mjs verify-live \
  --expected-commit <同一个提交SHA> \
  --manifest /tmp/fable-release/release-manifest.json \
  --origins https://node.example.com,https://cf.example.com
```

滚动发布时可附加 `--previous-manifest <上一版 release-manifest.json>` 保留上一代带哈希的静态资源，防止已打开页面的用户发生懒加载失败。
