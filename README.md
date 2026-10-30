# ✦ Starport Pi

**Windows 原生 Pi 工作台，命令交給遠端。**

使用 Pi SDK 與 Claude API，在網頁或終端設定訂閱、選擇出口、連接伺服器、編輯專案和查看任務。Windows 不需要 WSL2、Docker 或本機虛擬機；執行環境建立在 Linux 伺服器上。

![Starport Pi topology](docs/topology.svg)

| 工作台 | 遠端執行 |
| --- | --- |
| Windows 10/11、Linux、macOS | 現有 Linux／阿里 DSW 實例 |
| Pi SDK、Claude API、模型與 effort 選擇 | gVisor 工作區、CPU／記憶體／GPU 預算 |
| 部署向導、訂閱管理、Cloudflare 遠端入口 | 專案檔案、即時日誌、取消、產物下載 |
| 人工選擇檔案上傳，分塊續傳及 SHA-256 | 發布只讀資料版本，按資料 ID 使用 |

## Windows 開始使用

下載或克隆本倉庫，在專案目錄開啟 PowerShell：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

安裝後開啟 **http://127.0.0.1:18900/**，使用啟動視窗中的存取碼登入。

在「部署與管理」完成 **訂閱 → 伺服器 → 模型 → 遠端入口**。貼上 SSH 指令與私鑰，或填入 DSW ProxyClient 資訊；核對主機指紋後，系統自動安裝隔離環境並驗證。Cloudflare Token、網域前綴與信箱名單也可直接在面板設定。

網頁提供會話、思考／工具狀態、任務、增量日誌和檔案。手機可透過個別授權的 Tunnel + Access 網址使用。

後續啟動：`.\starport-pi.cmd panel`。Linux／macOS：`bash scripts/install.sh`，再執行 `npm run panel`。終端工作台仍可用 `npm start`。

## 遠端預設

**Asia/Taipei · zh_TW.UTF-8 · UTF-8 · Noto CJK TC**。每個任務有獨立的程序與網路空間，專案位於 `/workspace`，產物位於 `/output`，指定資料位於 `/data/shared/<id>`。沒有本機磁碟掛載，也沒有模型可呼叫的本機 shell 或設定工具。

模型 API 和任務外網流量經過所選代理；代理中斷時不回退直連。SSH／阿里管理通道由操作端單獨維護。區域設定決定語言、時間與字形，並不改變伺服器實際位置或服務可用地區。

## 指引

- [網頁部署向導、金鑰與遠端存取](docs/REMOTE_ACCESS.md)
- [Agent 安裝入口](AGENTS.md) · [安裝 Skill](skills/starport-setup/SKILL.md)
- [停用與卸載 Skill](skills/starport-uninstall/SKILL.md)
- [完整安裝與伺服器配置](docs/SETUP.md)
- [操作、檔案與共享資料](docs/USAGE.md)
- [隔離邊界與資源管理](SECURITY.md)
- [驗證範圍](docs/VALIDATION.md)

基於 [Pi](https://github.com/earendil-works/pi) 1.4.0 的獨立 SDK 工作台；終端保留專案會話和工具事件，配置選單由 Starport 提供。
