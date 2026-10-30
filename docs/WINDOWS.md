# Windows 與可選 WSL2

## 原生 Windows（預設）

Windows Terminal／PowerShell 直接啟動 Node.js 工作台。需要 Node.js 22.19+、OpenSSH Client；阿里 ProxyClient 連線另需 Python 3.12+。Mihomo 和阿里 ProxyClient 都使用 Windows 執行檔。

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
.\starport-pi.cmd configure
.\starport-pi.cmd auth
.\starport-pi.cmd
```

若沒有 OpenSSH Client，從 Windows「選用功能」安裝後重跑腳本。電腦已具備依賴時，可以用 `-InstallPrerequisites:$false` 避免呼叫 winget。

安裝後刷新 PATH 只影響目前程序，保留 shell／工具管理器已有的路徑並合併新增路徑；Node 與 npm 亦固定使用已找到的執行檔。Python worker 只在遠端 Linux 執行；本機使用 `npm test` 驗證客戶端。`npm run test:server` 在 Windows 會明確略過，不需要安裝 `fcntl`。

安裝器預設不註冊自動啟動。Agent 會詢問是否加入「目前使用者登入後啟動」，同意後才執行 `scripts/register-panel.ps1`；這不是登入前的 Windows 系統服務。

停用／卸載本機控制程序：先執行 `scripts/uninstall.ps1` 查看計畫，確認範圍後加上 `-Apply`。預設保留設定、憑證、會話和遠端資料；詳見[卸載 Skill](../skills/starport-uninstall/SKILL.md)。

操作端設定保存在 `%LOCALAPPDATA%\StarportPi`，使用當前帳號的 ACL。工作台不把 Windows 磁碟、使用者目錄、SSH Agent 或 API Key 掛載到遠端。Windows 螢幕、字型和系統時區不會被修改；繁體中文與台北時區套用在遠端任務內。

## WSL2（可選）

希望在 Linux 終端使用時才需要：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-wsl.ps1
# 若系統提示重新啟動，完成後開啟 Ubuntu，建立 Linux 使用者。
powershell -ExecutionPolicy Bypass -File .\scripts\setup-wsl.ps1 -Configure
```

腳本安裝 Ubuntu 24.04、Python、Git、字型與 locale；缺少相容 Node.js 時，從官方來源下載 Node.js 22 並核對 SHA-256。完成後重開 Ubuntu 終端，在 Linux 專案目錄執行 `bash scripts/install.sh`。

WSL2 只是工作台的另一個宿主；模型命令仍送往同一個遠端執行器。不要把 WSL 與 Windows 之間的磁碟／程序互通視為隔離邊界。[Microsoft 的 WSL 安全模型](https://github.com/microsoft/WSL/blob/master/doc/docs/technical-documentation/security.md)有具體說明。
