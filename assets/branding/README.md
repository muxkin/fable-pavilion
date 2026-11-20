# 品牌素材

子虚亭网页的昼夜背景、云纹与应用图标结构说明见 [网页素材](zixuting/README.md)。大体积分层设计原稿（`.kra` / `.xcf`）不纳入主代码仓库跟踪。

## Rust 桌面适配器图标

桌面适配器使用子虚亭的乌有图标：托盘与本机管理页使用 `src/web/public/app-icons/wuyou-192.png`，Linux DEB 与 macOS 应用图标使用对应的 512 像素版本。

Windows 安装程序与适配器共用 `assets/branding/zixuting/wuyou.ico`。重新生成此文件时执行（需要 ImageMagick 7）：

```bash
magick src/web/public/app-icons/wuyou-512.png -strip -alpha on \
  -define icon:auto-resize=256,128,64,48,32,16 assets/branding/zixuting/wuyou.ico
```
