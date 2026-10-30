# 隔离边界

Starport Pi 把操作端、控制通道、模型工具与执行环境分开。信任操作人员、Pi／Node.js 套件、SSH、gVisor 和服务器管理员；把模型生成的命令及项目内容视为不可信。

| 边界 | 实作 |
| --- | --- |
| 本机命令 | 不向模型注册本机 Bash、文件系统、设置或安装工具；不自动载入项目 extension、MCP、skill、AGENTS 或本机 context |
| SSH／云凭证 | 留在操作端；固定 RPC 命令，无 Agent forwarding，严格 host-key 验证，连线错误不回传管理资讯 |
| 宿主文件 | 干净唯读 rootfs；只挂当前 workspace、当前 output、明确选定的只读资料及单一出口 socket |
| 程序与网路 | gVisor 的独立 PID／IPC／UTS／network 视图，`--network=none`，无 capabilities，no-new-privileges |
| 外网 | guest loopback HTTP → 单一 Unix socket → SSH 反向转发 → 操作端 Mihomo → 选定节点；没有 DIRECT fallback |
| API | 只能透过 loopback 代理连接 Anthropic HTTPS API；代理失效即失败 |
| 区域设置 | 台北时区、繁体 locale、UTF-8、TC 字型；清空 machine-id 和 boot-id，固定 hostname |
| 文件操作 | descriptor-relative 路径、拒绝 traversal／symlink／特殊文件，分块及整档杂凑 |

rootless 单 UID 映射使用 **guest UID 0** 让持久化 bind 目录可写；它不具有宿主 root 文件系统或 Linux capabilities。任务不能挂入新的宿主目录、读取控制服务设置或进入另一个任务。

控制通道不经模型订阅代理，这是操作端连接阿里 API／SSH 所需的管理流量。任务无法取得这些连线凭证、管理主机地址或切换出口。订阅下载和执行档安装同样是人工操作，不属于模型工具。

## 资源与相容性

CPU 使用互不重叠的 affinity 预留，内存使用服务预算、MemAvailable 检查及执行时 RSS 监测。外层 DSW 的硬限制仍有效；RSS 轮询不是 cgroup 硬内存／程序数／磁碟配额，不适合把同一服务直接开放给互不信任的多租户。部署到专用实例，或由上层提供 cgroup 与磁碟 quota。

GPU 使用 gVisor nvproxy，限定装置和驱动库，核对精确驱动版本。GPU 型号、驱动资讯和 CUDA 可读的 GPU UUID 可能对程式可见；此版不承诺隐藏 GPU UUID。启用前需人工保留 GPU，当下显存闲置不代表其他排程器没有预留。

SSH 连线帐号是可信管理帐号。多名不互信的使用者应使用不同 worker／实例和密钥；资料 ID 不是跨使用者授权系统。不要让模型载入操作端 extension，或给它另一个能在操作端执行命令的工具。

地域设置不会变更实体位置、网路地理位置、帐号所属地区或供应商的使用资格。这是工作环境一致性与资料隔离工具，并不提供帐号风险保证。

## 公开版本

`python scripts/audit_source.py` 扫描候选文件中的真实路径、AccessKey、私钥、个人邮件、执行期目录和大型产物。设置及订阅位于作业系统使用者资料目录，Windows 使用 ACL、POSIX 使用 0700／0600。不要将操作端私有 state 目录加入 Git。

上游参考：[Pi](https://github.com/earendil-works/pi)、[gVisor 安装](https://gvisor.dev/docs/user_guide/install/)、[rootless](https://gvisor.dev/docs/user_guide/rootless/)、[GPU](https://gvisor.dev/docs/user_guide/gpu/)、[Mihomo API](https://wiki.metacubex.one/en/api/)。

## Web deployment control plane

The panel binds only to loopback. Local login uses a private random key. Cloudflare
mode requires a verified Access JWT; the old local cookie cannot bypass it. Remote
setup endpoints additionally require the operator key. Model tools do not include
setup, local key search, cloud enrollment or subscription operations.

Use distinct OS users/profiles and distinct remote worker users or instances for
unrelated people. An Access email list is a panel-wide permission, not a row-level
workspace ACL. Existing workers and unrelated tunnels are never overwritten.

Private-key search reads only the explicitly selected directory, compares public
key material, and skips symlinks. Elevation uses the native system prompt and a
one-operation helper; no system password is collected by the web application.
Generated deployment keys are unencrypted and protected by OS file permissions.
Encrypted keys should be loaded in the operating system SSH agent.

Official tool downloads are versioned and checksum-pinned in `src/tool-assets.json`.
The published rootfs is also checksum-pinned. Changing these pins requires review.

## Local Windows execution

Local project commands use a dedicated receipt-owned WSL2 distribution plus the
same gVisor worker. Windows automount and process interop are disabled before
first boot. No Windows path is bound into the guest. The fixed RPC and bounded
stdio proxy bridge are operator capabilities; model tools cannot change their
commands, select arbitrary distributions, or select a proxy destination. Project
files remain in the dedicated virtual disk and can be transferred explicitly.

WSL2 and gVisor compatibility must pass on the target machine. The client never
falls back to a normal local shell. The fixed locale reduces incidental host
metadata exposure but is not an anonymity guarantee; shared-kernel resource
limits and generic hardware properties retain the limitations described above.

Encrypted configuration exports contain deployment secrets. AES-256-GCM with a
scrypt-derived key authenticates each export. Import is operator-only, rejects
existing profiles, rebuilds private paths, and never imports trust or live process
identities. It does not automatically grant remote worker execution or publish a
Cloudflare endpoint.

## SSH administrative access

The operator profile currently uses ordinary SSH accounts to install and invoke
the worker. The client chooses a fixed RPC command, but the SSH credential itself
is not restricted by the server to that command. A holder of an administrative
key can use another SSH client to access files allowed by that account. Do not
distribute administrative exports as restricted-user profiles. Enforcing the
same boundary for arbitrary SSH clients requires a dedicated account or a
server-enforced command on a separate key, with forwarding controlled separately.
Existing administrative keys and running services are not modified by import.
