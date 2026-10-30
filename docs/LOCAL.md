# 本机隔离项目

面板默认使用简体中文。创建会话时，可选纯聊天、Windows 本机隔离项目或远端项目。

| 模式 | 需要服务器 | 命令与文件 |
| --- | --- | --- |
| 纯聊天 | 不需要 | 不提供项目或本机执行工具；可启用 Anthropic 服务端工具和会话附件，API 仍使用选定代理 |
| 本机隔离项目 | 不需要远端服务器 | 专用 WSL2 中的 gVisor，只挂载当前项目、当前任务产物和明确选择的数据 |
| 远端项目 | Linux／DSW worker | 相同工具接口，通过 SSH 固定 RPC 访问 |

## Windows 初始化

1. 运行原生安装器，进入“部署与管理”。导入订阅并应用出口，填写 Claude API Key。
2. 若系统尚未启用 WSL2，在管理员 PowerShell 运行：

   ```powershell
   wsl --install --no-distribution
   ```

   如果系统提示重启，由使用者完成重启后继续。
3. 在“本机隔离”中填写 CPU、内存，点击“初始化并验证本机环境”。预算必须小于 WSL2 实际可用资源。默认 4 核、4 GiB，资源较少时可设为 2 核、2 GiB。
4. 初始化创建独立的 `StarportRuntime-<随机标识>`，下载并校验 rootfs 和完整 gVisor。不会覆盖其他发行版、修改全局 `.wslconfig` 或执行 `wsl --shutdown`。
5. 实际区域设置、直连阻断、空 machine-id 和资源释放检查全部通过，才启用“本机隔离项目”。不兼容时保留失败原因，不退回普通 shell。

目前此入口提供 **Windows x64、CPU 执行**。WSL2 GPU `/dev/dxg` 尚未接入；需要 GPU 时选择远端服务器。Linux／macOS 面板仍支持纯聊天和远端项目。

## 项目文件

每个会话有自己的持久项目目录，在任务内显示为 `/workspace`。它实际保存在该专用 WSL2 磁盘中，不直接映射 Windows 的整个项目目录。通过面板上传需要的源文件，修改后下载文件或让任务生成归档再下载；同一项目内可以初始化 Git。

项目、产物、模型会话分别保存。关闭网页不会删除项目。导入配置不会复制项目数据或注册旧 WSL2 实例；新电脑需要重新初始化本机运行环境。

## 环境和网络

- 固定 `Asia/Taipei`、`zh_TW.UTF-8`、UTF-8、Noto CJK TC；命令不继承操作端环境变量或凭证。
- 专用 WSL2 从第一次启动就关闭 Windows 磁盘自动挂载和 Windows 程序互操作。
- 模型命令在 gVisor 中执行，不能启动 WSL 管理命令、Windows 程序或操作管理面板。
- gVisor 使用 `--network=none`。任务经 Unix socket 和受控 stdio 通道到本机 Mihomo，再使用选定节点。通道和代理故障时保持断网，没有直连备用出口。
- API Key、SSH 私钥、订阅与 Cloudflare Token 由操作端保管，不挂入项目。

执行层的资源预算、RSS 监测和只读基础文件系统与远端 worker 相同。它面向自己的开发项目；CPU 架构等通用硬件特征仍可能可见，区域配置不会改变实际物理位置。详细边界见 [SECURITY.md](../SECURITY.md)。

WSL2 导入流程依据 [Microsoft WSL 命令](https://learn.microsoft.com/en-us/windows/wsl/basic-commands)；每发行版的挂载及互操作设置见 [wsl.conf](https://learn.microsoft.com/en-us/windows/wsl/wsl-config)。实际执行兼容性由目标机器上的隔离自测决定。
