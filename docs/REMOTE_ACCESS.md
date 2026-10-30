# 网页工作台与远端访问

Windows 原生执行；WSL2 不需要。安装完成后开启 `http://127.0.0.1:18900/`，使用启动窗口中的本机访问码登入。

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

安装器检查 Node.js、Python、OpenSSH，建置网页并启动面板。若 Windows 缺少 OpenSSH，会使用系统 UAC 窗口安装；密码不会写入设置。只安装、不开启面板：加上 `-LaunchPanel:$false`。后续启动：

```powershell
.\starport-pi.cmd panel
```

Linux／macOS：`bash scripts/install.sh`，然后 `npm run panel`。

## 部署向导

点右上角「部署与管理」，依序完成：

1. **订阅与出口**：填 HTTPS 订阅，或贴上 YAML／SS／VMess／VLESS／Trojan 清单。导入后选节点，按「套用并启动」。工具自动下载固定版本 Mihomo 并验证 SHA-256，不修改系统代理。更新订阅后需重新套用选定节点。
2. **服务器**：填 SSH 指令与私钥，或使用 DSW ProxyClient 表单。设置本服务的 CPU、内存与专用 GPU 编号，新增后测试连线。第一次核对主机指纹，再按「初始化环境」。
3. **模型**：填自己的 Anthropic API Key，选默认模型。
4. **远端入口**：填 Cloudflare Token、托管网域、前缀及允许登入的完整信箱。先检查并分配网址，再套用 Tunnel + Access。

下载工具、上传执行环境及验证会显示进度。失败保留原因，未通过初始化的服务器不出现在新会话选单中。

### SSH／阿里 DSW

直连栏位接受：

```text
ssh -p 22 worker@host
ssh -i path/to/key -p 2222 worker@host
```

`-i` 的原路径不会直接读取；请另选私钥档、贴上私钥，或使用「SSH 密钥」页的匹配结果。指令不接受尾端 shell 命令、任意 `-o`、ProxyCommand 或转发旗标。

VPC 位址需要目前电脑已有 VPC／VPN 路径；私钥本身不会建立这条路径。没有直连路径时选 **DSW ProxyClient**：填实例 ID、实际区域、SSH 私钥、AccessKey ID／Secret，使用 STS 时另填 Token。ProxyClient 由工具自动下载并校验。DSW 必须已启用 SSH 并装入对应公钥；ProxyClient 的 RAM 身分需要 `paidsw:GetToken`。[官方连线说明](https://help.aliyun.com/zh/pai/connect-to-a-dsw-instance-over-ssh)。

初始化会新增独立的 gVisor 执行环境，建立反向出口通道，执行区域与身份隔离自测并确认测试资源释放。成功后才启用服务器。现有 worker 不会被直接覆写；中断的本次安装可重新验证。只分配已保留给本服务的资源。GPU 初始化完成表示已配置设备，首次实际 GPU 计算仍需小任务验收。

目前发布的 rootfs 是 Linux x86_64。Windows／macOS 是工作台，远端工作节点仍使用 Linux。基础环境包含 Python／Git／Bash，不包含完整深度学习套件。

## SSH 密钥

在 Windows PowerShell、Linux 或 macOS 终端执行：

```text
ssh-keygen -t ed25519 -C "starport"
```

按提示选择路径与密语。默认公钥是 `.ssh/id_ed25519.pub`，私钥是同目录的 `id_ed25519`。**只把公钥放到服务器的 `authorized_keys`。**

Windows 查看公钥：

```powershell
Get-Content "$env:USERPROFILE\.ssh\id_ed25519.pub"
ssh-keygen -lf "$env:USERPROFILE\.ssh\id_ed25519.pub"
ssh-add "$env:USERPROFILE\.ssh\id_ed25519"
```

若 ssh-agent 尚未启动，可在系统服务设置启用 OpenSSH Authentication Agent，或用管理员 PowerShell 执行 `Set-Service ssh-agent -StartupType Automatic` 和 `Start-Service ssh-agent`。私钥密语由 `ssh-add` 在本机读取。

从**已有私钥**取回公钥：

```text
ssh-keygen -y -f path/to/private_key
```

不能从公钥还原遗失的私钥。面板的「查找匹配私钥」会读取指定目录的候选私钥，提取公钥后比对；不只信任同名 `.pub`。默认仅搜寻目前使用者 `.ssh` 的第一层，最多 200 个项目，不跟随符号连结。

受保护目录可使用「系统授权后查找指定目录」：Windows UAC、macOS 管理员窗口、Linux Polkit。须先填完整公钥与确切目录，成功后仅复制匹配的私钥到本设置档的私有目录。系统密码不经过网页，也不储存。加密密钥会标记为待解锁，不把未验证的 sidecar 当作匹配成功。面板另外提供无密语的部署专用密钥生成；需要密语时使用上面的指令。

## Cloudflare Token 与登入名单

Token 权限限定在目标帐户和网域：

| 范围 | 权限 |
| --- | --- |
| Account | Cloudflare Tunnel Edit |
| Account | Access: Apps and Policies Edit |
| Account | Access: Organizations, Identity Providers, and Groups Read |
| Zone | Zone Read、DNS Edit |

Zero Trust 帐户需已设置登入方式，例如电子邮件一次性 PIN。工具不更改整个帐户的登入方法。输入的是 Cloudflare API Token，不是主帐号密码或 Global API Key。

每次建立 `console-<随机后缀>.example.com`，也可填另一个前缀。工具先查 DNS／Access 是否占用，先建可重用的精确信箱允许政策与独立应用，再验证来源站已拒绝匿名访问，最后才发布 DNS。连接器使用私有 token 文件，不把 token 放在程序参数里。

| 面板 | 允许信箱 |
| --- | --- |
| 你的面板 | 你的信箱 |
| 成员 A 的面板 | 成员 A；如需管理可明确加入你的信箱 |
| 成员 B 的面板 | 成员 B；如需管理可明确加入你的信箱 |

Access 登入权不等于 Cloudflare 管理权。来源站验证 JWT 签名、issuer、audience、期限及完整信箱；只伪造 email header 不会通过。远端「部署与管理」另需本机访问码。此面板内允许的使用者共享此面板资料；不同人的资料隔离应使用不同 OS 帐户／设置档及独立远端 worker 帐户或实例，不能只换网址。

启用 Access 后，本机 `http://127.0.0.1:18900/` 仍使用本机访问码，公网 HTTPS 网址使用 Access 登录，两种入口各自验证来源。端口以实际启动配置为准。本机 cookie 不被公网入口接受；Tunnel 固定使用分配的公网 Host，带转发标记的请求不能走本机登录。

旧版在应用 Access 后若显示 `origin_not_allowed`，更新工作台并重新启动面板，从原本机网址登录后再次点击「应用 Access 并启动 Tunnel」。保留私有配置及 `cloudflare/receipt.json`，系统会核对并接续已创建的资源，无需重新分配网址或删除 Access 设置。

### Agent／CLI 配置

将 `examples/cloudflare.example.json` 复制到私有设置目录，填入网域与信箱，Token 放在同目录 `api-token`。POSIX 文件权限使用 `chmod 600 api-token`。在同一 `STARPORT_PI_STATE` 下启动面板后执行：

```text
node bin/starport-cloudflare.mjs plan path/to/private-enrollment.json
node bin/starport-cloudflare.mjs apply path/to/private-enrollment.json
node bin/starport-cloudflare.mjs status path/to/private-enrollment.json
```

面板会启动并维护自己的 cloudflared。单独连接器也可用 `node bin/starport-cloudflare.mjs start`，需要 PATH 中有 cloudflared 2025.4.0+。不要同时启动重复连接器。

中断后 `status` 按本次唯一名称核对资源，`apply` 接续已完成阶段。创建结果不明且无法核对时停止，不盲目重试。`rollback` 只删除此设置档记录且内容仍匹配的资源，先删 DNS，来源站仍保持 Access 保护；不更改其他控制台。

## 会话、任务、日志和文件

会话持续在背景执行，切换页面不停止任务。思考／工具状态与已用时间会更新；讯息使用序号增量同步，已有内容保留。Markdown 与命令卡片可直接阅读。模型产生的命令只走远端 worker。

「停止回复」停止模型生成；「取消此任务」只取消指定计算。任务页提供增量日志与产物下载，执行中的任务也能读取 `/output`。文件页只读写该会话工作区。上传使用 1 MiB 分块、整体与分块 SHA-256，同一浏览器分页重选相同文件可以接续；文件内容不保留于浏览器储存。

附加的文件放入远端工作区，讯息加入其路径；本版不把图片转成模型视觉内容。网页不自动载入讯息中的第三方图片，避免外部追踪请求。

## 登入后自动启动

Windows 提供目前使用者的登入启动工作，不需要储存系统密码：

安装器默认不注册。使用安装 Skill 时，Agent 会先询问；只有明确同意才执行下列注册命令。

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\register-panel.ps1
# 移除本设置档的启动工作
powershell -ExecutionPolicy Bypass -File .\scripts\register-panel.ps1 -Remove
```

这是在使用者登入后启动，并非登入前的 Windows 系统服务。面板重新启动后会恢复本设置档的 Mihomo、已验证服务器的出口通道及 Cloudflare 连接器。其他设置档和其他应用的服务不受影响。

代理故障不回退直连；重新连接不会取消训练。Token 过期、SSH 密钥更改或 VPC 路径不可达，仍需在管理页修正对应设置。

官方依据：[Tunnel API](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel-api/)、[Access 政策](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/)、[JWT 验证](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)。

## 停用与卸载

```powershell
# 只显示本设置档的处理计划
powershell -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1
# 停用登入启动，停止确认属于本设置档的本机程序
powershell -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1 -Apply
```

默认保留仓库、设置、凭证、会话、Cloudflare 资源与远端 worker。停用本机代理会中断依赖它的任务外网连线；不会替你取消远端训练。删除资料或移除云端资源须另行指定，流程见[卸载 Skill](../skills/starport-uninstall/SKILL.md)。
