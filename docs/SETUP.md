# 安装与配置

## 1. 工作台

Windows 使用 `scripts/install.ps1`；Linux／macOS 使用 `scripts/install.sh`。完成后执行 `node bin/starport-pi.mjs configure`。

订阅选单支援 Clash／Mihomo YAML，以及 SS、VMess、VLESS、Trojan URI 列表和 Base64 列表；接受 TCP、WebSocket、gRPC，以及 SS 的内建 obfs／v2ray-plugin 选项。从 [Mihomo 官方发布](https://github.com/MetaCubeX/mihomo/releases)取得对应系统的执行档，在选单填入路径。

选择节点后执行「启动／套用出口」。使用独立的 loopback 代理与带随机密钥的管理端口；不接管既有系统代理。更新 HTTPS 订阅后再次套用。提供者的 routing、DIRECT fallback、脚本和公开监听设置不会直接导入。

套用出口影响新连线；执行中任务的既有连线可以继续使用原节点，避免中途截断传输。下一次模型请求会重新建立对应代理连线。

API Key 透过 `node bin/starport-pi.mjs auth` 的隐藏输入保存。聊天内容只交给设置的模型；订阅与服务器设置选单不进入会话。

## 2. 连接既有服务器

服务器需要 Linux 5.6+、Python 3.10+、SSH、可用的 user namespace，以及 gVisor 所需的系统呼叫。一般 Linux、ECS 或 DSW 均可先验证；外层平台若禁止必要功能，安装或验证会报错，不会降级成宿主 shell。

一般 SSH：先建立自己的 SSH 别名，在 `/servers` 新增它。

阿里 DSW：

1. 按[官方 ProxyClient 指引](https://help.aliyun.com/zh/pai/connect-to-a-dsw-instance-over-ssh)下载 Windows／Linux／macOS 版本。
2. 在操作端执行 `proxyclient config`（Windows 为 `proxyclient.exe config`），建立私有设置。使用自己的 RAM／STS 凭证；连线需要 `paidsw:GetToken` 及 SSH 密钥。STS 到期需由操作端更新。
3. 在实例中配置自己的 SSH 公钥。现有 SSH 已正常时直接复用，不需重启。
4. 在 `/servers` 选择阿里 DSW，填入实际区域、实例 ID、ProxyClient、凭证档和 SSH 私钥路径。可参考 `examples/connection.example.json` 的栏位。
5. 执行 `/verify-server`，与服务器端显示的 SSH 指纹核对后接受。后续连线固定使用严格主机密钥验证。

上述管理资料只存于操作端。模型看见的是公开别名、可用资源及项目路径。

## 3. 建立远端执行环境

从本仓库的 Release 下载 `rootfs.tar.gz` 及校验档，或在有 Podman／Docker 的 Linux 建置机产生：

```bash
bash scripts/build-rootfs.sh
# 若使用 Docker：CONTAINER_ENGINE=docker bash scripts/build-rootfs.sh
```

建置只需做一次。Windows 使用者可直接使用已发布的 rootfs，不需安装 Docker 或 WSL。

在工作台执行 `/install-server`，选择 rootfs 并设置 CPU／内存预算。安装器：

- 验证传输 SHA-256，安全解包干净 rootfs。
- 操作端经所选代理下载固定版本的 gVisor 完整套件，验证 SHA-512，再经 SSH 上传；服务器不需要直连下载站。保留 runsc 和配套 sidecar。
- 新增使用者专属目录，记录 runtime 杂凑；不修改原有 Python 环境、Docker、SSH 或其他服务。
- 已存在安装时拒绝覆盖，避免影响执行中的任务。

需要离线 runtime 时，管理员可在服务器使用下列方式；指定的 `runsc` 旁必须有同一版本的 `gvisor-bin`：

```bash
python3 server/install.py --rootfs rootfs.tar.gz --sha256 EXPECTED_SHA256 \
  --runsc ./gvisor/runsc --runsc-sha256 EXPECTED_RUNSC_SHA256 \
  --cpus 8 --memory-gib 32
```

已有其他工作负载时，优先使用专用实例；若共用，使用 `--cpu-indices` 配置不重叠的 CPU，并事先保留相应内存。此工作台不读取第三方排程器的预留表。

## 4. 验收与 GPU

```text
/workspace
/tunnel
```

另开终端执行 `node bin/starport-pi.mjs probe`，再让模型查看返回任务的日志；应包含 `passed: true`。检查涵盖台北时区、繁体 locale、UTF-8、TC 字型、机器标识与直接网路封锁。

GPU 是可选能力。`/gpu` 先核对驱动与 gVisor 的精确版本相容性，再由操作人员确认 GPU 已专门分配给此服务。只挂载经杂凑核对的 CUDA／NVML 使用者库和所选装置，不挂载宿主的整个 `/usr` 或 `/sys`。不支援的驱动会拒绝启用，不自动安装或修改驱动。GPU smoke command 是 `python3 /opt/starport/gpu_probe.py`，提交时指定 `gpus: 1`。

基础 rootfs 提供 Python、Git、Bash 和字型；PyTorch／Isaac Lab 等应用依赖不包含在内，可透过受控出口在 `/workspace/.venv` 安装，或由管理员建置专用干净 rootfs。[gVisor GPU 支援范围](https://gvisor.dev/docs/user_guide/gpu/)应与实际驱动一并验证。
