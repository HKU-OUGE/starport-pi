# 配置导入与导出

进入“部署与管理 → 导入与导出”。默认模型在“模型”页和会话工具栏通过列表选择，列表来自当前安装的 Pi 模型目录。

## 导出

填写至少 12 字符的密码，下载 `starport-profile.encrypted.json`。它使用 scrypt 派生密钥和 AES-256-GCM 加密并校验，包含：

- 默认模型和 effort。
- 订阅、节点、选定出口及后续刷新地址。
- 服务器连接、私钥、DSW 凭证和资源预算。
- Claude API Key。
- Cloudflare 域名、前缀、邮箱及已保存的管理 API Token。

密码不会写入导出包。下载文件与密码分开保管。没有配置的项目保持缺省，导入前会显示 API Key／Cloudflare Token 是否齐全。

## 导入

1. 在一台新电脑安装 Starport Pi，并打开面板。
2. 选择加密文件，填写密码，点击“检查配置”。
3. 核对模型、订阅及服务器数量，点击“导入到当前新配置”。可同时安装 Mihomo 并应用选定出口。
4. 已有服务器需要重新核对 SSH 主机指纹；新 worker 的初始化和隔离验证通过后才能执行任务。与其他服务共用机器时，先核对可分配 CPU、内存和 GPU，避免重复预留。
5. Cloudflare 点击检查／分配网址后再应用。它创建新的入口，不复制旧 Tunnel 身份。

导入不会覆盖已有配置。失败的字段校验不会留下半套可用设置；不支持用此功能跨电脑搬运运行中的任务。操作端绝对路径在导入时重建，工作区、会话、PID、信任指纹、Tunnel Token 和自启动选择都不迁移。

原有训练服务与此仓库的 Pi worker 可能采用不同协议：连接参数可以复用，但不因此被认定为已初始化。不要覆盖原服务目录或重启运行中的实例。

## Cloudflare 权限

创建自定义 API Token：

| 范围 | 权限 | 级别 |
| --- | --- | --- |
| Account | Cloudflare One Connector: cloudflared（或 Cloudflare Tunnel） | Edit / Write |
| Account | Access: Apps and Policies | Edit / Write |
| Account | Access: Organizations, Identity Providers, and Groups | Read |
| Zone | Zone | Read |
| Zone | DNS | Edit / Write |

账户资源限定目标账户，域名资源限定目标 Zone。DNS 权限在 Zone 分类中；无需 Account DNS Settings、Registrar 或 Workers 权限。登录邮箱控制面板访问权，不能限制管理 API Token 自身的权限。

参考 [官方权限清单](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)和 [Tunnel API 指引](https://developers.cloudflare.com/tunnel/get-started/)。
