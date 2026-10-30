# 第三方元件

本仓库原创程式使用 MIT 授权；第三方元件保留各自授权。

- Pi 1.4.0：透过 npm 安装，来源与授权见 [Pi](https://github.com/earendil-works/pi)。
- Mihomo：面板或使用者从[上游发布](https://github.com/MetaCubeX/mihomo/releases)安装；未随此仓库重新打包。
- gVisor：安装器下载上游固定版本的完整套件并核对校验，来源见 [gVisor](https://github.com/google/gvisor)。
- 基础 rootfs：由 `server/Dockerfile` 从 [Docker Official Python](https://github.com/docker-library/python) 的 Debian Bookworm 映像建置。CPython、Debian 系统套件与 Noto 字型保留原始授权，套件版号可由映像的 `/var/lib/dpkg/status` 查阅，著作权声明位于 `/usr/share/doc/*/copyright`。
- Debian 套件对应原始码：[Debian Sources](https://sources.debian.org/)、[Debian Snapshot](https://snapshot.debian.org/)。Python 原始码：[python.org](https://www.python.org/downloads/source/)。Noto 字型：[Noto CJK](https://github.com/notofonts/noto-cjk)。

`package-lock.json` 固定 JavaScript 依赖。Pi 的间接 Undici 依赖使用已修补的 8.12.3；操作端代理使用与 Node.js 22 fetch 相容的 7.30.1。

- 网页：React、Vite、react-markdown、hash-wasm；依赖版本固定于 package-lock.json。
- Access JWT：jose；来源站验证签名与应用 audience。
- cloudflared 与阿里 ProxyClient：按官方来源与固定 SHA-256 下载，未把执行档打包到仓库。
