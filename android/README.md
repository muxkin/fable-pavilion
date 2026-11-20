# 子虚亭 Android

Android 应用默认连接 `https://app.fablepavilion.com`。扫码登录时，邀请二维码中的 HTTPS 地址会成为应用当前站点，并留到下次启动。账号和缓存按站点保存。新设备点「出示本机登录码」即可显示二维码。已登录设备扫码并核对代码后确认，新设备就会自动登录。页面、样式和业务功能通过现有 Web 发布交付。

应用支持 Android 8.0（API 26）及以上。返回手势先处理当前页面里的弹层或历史，到顶层时关闭 Activity。外部链接通过 Android 浏览器打开。相机和麦克风按需向系统申请权限。「照片」打开 Android 照片选择器，较旧系统会打开仅显示图片的文件选择器。「附件」和保存下载使用系统文件选择器。

## 构建签名 APK

安装 JDK 17 或以上、Android SDK Platform 36 和 Build Tools 36.0.0。提供同一签名证书，可以在保留应用数据的情况下安装后续外壳版本。将签名密钥和密码文件保存在仓库外。

```bash
export ANDROID_HOME=/path/to/android-sdk
export FABLE_ANDROID_KEYSTORE=/path/to/signing.p12
export FABLE_ANDROID_PASSWORD_FILE=/path/to/password-file
./android/build.sh
```

默认产物位于 `android/build/fable-pavilion-<版本>.apk`。可以通过第一个参数指定输出路径，通过 `FABLE_ANDROID_ORIGIN` 更改首次安装的默认 HTTPS 站点。升级外壳时设置新的 `FABLE_ANDROID_VERSION` 和递增的 `FABLE_ANDROID_VERSION_CODE`。

```bash
adb install -r android/build/fable-pavilion-<版本>.apk
```

## 发布新版本

Android 外壳更新时，使用现有签名密钥构建新 APK。将最终签名的 `fable-pavilion-android-<版本>.apk` 与 `latest.json` 保存在 Git 忽略的私有发布目录（例如 `local/downloads/android/`），构建网页时通过部署参数 `POCKET_ANDROID_DOWNLOADS_DIR=/absolute/path/to/downloads/android` 注入到发布产物中，不要将二进制 APK 提交到源码仓库。清单里的 `versionCode` 对应 APK 的递增版本号，`bytes` 和 `sha256` 对应最终签名文件。

Android 应用在前台定期检查安装包版本，发现更新后交给系统后台下载。应用核对大小、SHA-256、包名、版本和签名证书后，才提示安装。允许通知后，应用处于后台时也能收到完成提醒。用户自行确认安装。网页版本独立检查更新，仍可在下载页刷新。

## 可选验签模式

设置 `FABLE_ANDROID_FRONTEND_VERIFY=1`（或 `POCKET_FRONTEND_VERIFY=1`）、`POCKET_FRONTEND_PUBLIC_KEY_FILE` 为发布公钥 PEM、`FABLE_ANDROID_FRONTEND_RELEASE_DIR` 为签名产物的 `_release` 目录（默认输出在 `dist/frontend-pages/_release`）。用 `FABLE_ANDROID_ORIGIN` 指定提供签名包的入口，再运行构建脚本。验签版需要 Android 9 或更新版本，沿用验签版的隔离 WebView 数据目录。首次从普通版切换后需重新登录。

验签版 APK 内置一份签名网页资源。应用启动时读取本机已验签的资源，并通过构建时配置的入口检查网页和 APK 更新。扫码可切换到运行兼容 API 的 HTTPS 站点，登录、同步和中继连接使用这个站点，网页发布入口与公钥继续沿用安装包的配置。若自建站点需要发布自己的签名网页，请用对应的发布入口和公钥构建验签 APK。详细部署见 [前端发布验签](../docs/deploy/frontend-verification.md)。
