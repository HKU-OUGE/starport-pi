# ✦ Starport Pi

**Windows 原生 Pi 工作台，命令交給遠端。**

使用 Pi SDK 與 Claude API，在同一個終端設定訂閱、選擇出口、連接伺服器、編輯專案和查看任務。Windows 不需要 WSL2、Docker 或本機虛擬機；執行環境建立在 Linux 伺服器上。

![Starport Pi topology](docs/topology.svg)

| 工作台 | 遠端執行 |
| --- | --- |
| Windows 10/11、Linux、macOS | 現有 Linux／阿里 DSW 實例 |
| Pi SDK、Claude API、模型與 effort 選擇 | gVisor 工作區、CPU／記憶體／GPU 預算 |
| 常見訂閱匯入、節點選擇與更新 | 專案檔案、即時日誌、取消、產物下載 |
| 人工選擇檔案上傳，分塊續傳及 SHA-256 | 發布只讀資料版本，按資料 ID 使用 |

## Windows 開始使用

下載或克隆本倉庫，在專案目錄開啟 PowerShell：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
.\starport-pi.cmd configure
.\starport-pi.cmd auth
.\starport-pi.cmd
```

安裝器檢查 Node.js 22.19+、Python 與 OpenSSH，必要時透過 winget 安裝 Node.js／Python。`auth` 使用自己的 Anthropic API Key；此版接入 API 計費。

進入工作台後：

```text
/network          匯入訂閱，選節點，啟動／套用出口
/servers          新增 SSH 或阿里 DSW 連線
/verify-server    首次核對 SSH 主機金鑰
/install-server   上傳 rootfs，設定伺服器資源預算
/workspace        建立遠端專案
/tunnel           接通受控出口
/status           查看服務狀態
```

然後輸入一般訊息即可開始工作。`/upload`、`/download` 管理檔案，`/model` 切換模型和 effort，`/gpu` 檢查並配置 GPU，`/help` 列出入口。

Linux／macOS：`bash scripts/install.sh`，再執行 `npm start`。WSL2 為可選項：[Windows 與 WSL2](docs/WINDOWS.md)。

## 遠端預設

**Asia/Taipei · zh_TW.UTF-8 · UTF-8 · Noto CJK TC**。每個任務有獨立的程序與網路空間，專案位於 `/workspace`，產物位於 `/output`，指定資料位於 `/data/shared/<id>`。沒有本機磁碟掛載，也沒有模型可呼叫的本機 shell 或設定工具。

模型 API 和任務外網流量經過所選代理；代理中斷時不回退直連。SSH／阿里管理通道由操作端單獨維護。區域設定決定語言、時間與字形，並不改變伺服器實際位置或服務可用地區。

## 指引

- [完整安裝與伺服器配置](docs/SETUP.md)
- [操作、檔案與共享資料](docs/USAGE.md)
- [隔離邊界與資源管理](SECURITY.md)
- [驗證範圍](docs/VALIDATION.md)

基於 [Pi](https://github.com/earendil-works/pi) 1.4.0 的獨立 SDK 工作台；終端保留專案會話和工具事件，配置選單由 Starport 提供。
