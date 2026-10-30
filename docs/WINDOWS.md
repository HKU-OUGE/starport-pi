# Windows 与可选 WSL2

## 原生 Windows（默认）

Windows Terminal／PowerShell 直接启动 Node.js 工作台。需要 Node.js 22.19+、OpenSSH Client；阿里 ProxyClient 连线另需 Python 3.12+。Mihomo 和阿里 ProxyClient 都使用 Windows 执行档。

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
.\starport-pi.cmd configure
.\starport-pi.cmd auth
.\starport-pi.cmd
```

若没有 OpenSSH Client，从 Windows「选用功能」安装后重跑脚本。电脑已具备依赖时，可以用 `-InstallPrerequisites:$false` 避免呼叫 winget。

安装后刷新 PATH 只影响目前程序，保留 shell／工具管理器已有的路径并合并新增路径；Node 与 npm 亦固定使用已找到的执行档。Python worker 只在远端 Linux 执行；本机使用 `npm test` 验证客户端。`npm run test:server` 在 Windows 会明确略过，不需要安装 `fcntl`。

安装器默认不注册自动启动。Agent 会询问是否加入「目前使用者登入后启动」，同意后才执行 `scripts/register-panel.ps1`；这不是登入前的 Windows 系统服务。

停用／卸载本机控制程序：先执行 `scripts/uninstall.ps1` 查看计划，确认范围后加上 `-Apply`。默认保留设置、凭证、会话和远端资料；详见[卸载 Skill](../skills/starport-uninstall/SKILL.md)。

操作端设置保存在 `%LOCALAPPDATA%\StarportPi`，使用当前帐号的 ACL。工作台不把 Windows 磁碟、使用者目录、SSH Agent 或 API Key 挂载到远端。Windows 萤幕、字型和系统时区不会被修改；繁体中文与台北时区套用在远端任务内。

## 专用 WSL2 本机执行

本机项目通过面板“本机隔离”初始化，详见 [本机隔离项目](LOCAL.md)。它创建独立的受控发行版，不使用下面的通用 Ubuntu 工作台。

## WSL2 终端工作台（可选）

希望在 Linux 终端使用时才需要：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-wsl.ps1
# 若系统提示重新启动，完成后开启 Ubuntu，建立 Linux 使用者。
powershell -ExecutionPolicy Bypass -File .\scripts\setup-wsl.ps1 -Configure
```

脚本安装 Ubuntu 24.04、Python、Git、字型与 locale；缺少相容 Node.js 时，从官方来源下载 Node.js 22 并核对 SHA-256。完成后重开 Ubuntu 终端，在 Linux 项目目录执行 `bash scripts/install.sh`。

此 Ubuntu 安装方式只是工作台的另一个宿主；模型命令仍送往同一个远端执行器。不要把 WSL 与 Windows 之间的磁碟／程序互通视为隔离边界。[Microsoft 的 WSL 安全模型](https://github.com/microsoft/WSL/blob/master/doc/docs/technical-documentation/security.md)有具体说明。
