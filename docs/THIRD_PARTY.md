# 第三方元件

本倉庫原創程式使用 MIT 授權；第三方元件保留各自授權。

- Pi 1.4.0：透過 npm 安裝，來源與授權見 [Pi](https://github.com/earendil-works/pi)。
- Mihomo：使用者從[上游發布](https://github.com/MetaCubeX/mihomo/releases)安裝；未隨此倉庫重新打包。
- gVisor：安裝器下載上游固定版本的完整套件並核對校驗，來源見 [gVisor](https://github.com/google/gvisor)。
- 基礎 rootfs：由 `server/Dockerfile` 從 [Docker Official Python](https://github.com/docker-library/python) 的 Debian Bookworm 映像建置。CPython、Debian 系統套件與 Noto 字型保留原始授權，套件版號可由映像的 `/var/lib/dpkg/status` 查閱，著作權聲明位於 `/usr/share/doc/*/copyright`。
- Debian 套件對應原始碼：[Debian Sources](https://sources.debian.org/)、[Debian Snapshot](https://snapshot.debian.org/)。Python 原始碼：[python.org](https://www.python.org/downloads/source/)。Noto 字型：[Noto CJK](https://github.com/notofonts/noto-cjk)。

`package-lock.json` 固定 JavaScript 依賴。Pi 的間接 Undici 依賴使用已修補的 8.12.3；操作端代理使用與 Node.js 22 fetch 相容的 7.30.1。
