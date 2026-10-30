# 網頁工作台與遠端存取

Windows 原生執行；WSL2 不需要。安裝完成後開啟 `http://127.0.0.1:18900/`，使用啟動視窗中的本機存取碼登入。

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

安裝器檢查 Node.js、Python、OpenSSH，建置網頁並啟動面板。若 Windows 缺少 OpenSSH，會使用系統 UAC 視窗安裝；密碼不會寫入設定。只安裝、不開啟面板：加上 `-LaunchPanel:$false`。後續啟動：

```powershell
.\starport-pi.cmd panel
```

Linux／macOS：`bash scripts/install.sh`，然後 `npm run panel`。

## 部署向導

點右上角「部署與管理」，依序完成：

1. **訂閱與出口**：填 HTTPS 訂閱，或貼上 YAML／SS／VMess／VLESS／Trojan 清單。匯入後選節點，按「套用並啟動」。工具自動下載固定版本 Mihomo 並驗證 SHA-256，不修改系統代理。更新訂閱後需重新套用選定節點。
2. **伺服器**：填 SSH 指令與私鑰，或使用 DSW ProxyClient 表單。設定本服務的 CPU、記憶體與專用 GPU 編號，新增後測試連線。第一次核對主機指紋，再按「初始化環境」。
3. **模型**：填自己的 Anthropic API Key，選預設模型。
4. **遠端入口**：填 Cloudflare Token、託管網域、前綴及允許登入的完整信箱。先檢查並分配網址，再套用 Tunnel + Access。

下載工具、上傳執行環境及驗證會顯示進度。失敗保留原因，未通過初始化的伺服器不出現在新會話選單中。

### SSH／阿里 DSW

直連欄位接受：

```text
ssh -p 22 worker@host
ssh -i path/to/key -p 2222 worker@host
```

`-i` 的原路徑不會直接讀取；請另選私鑰檔、貼上私鑰，或使用「SSH 金鑰」頁的匹配結果。指令不接受尾端 shell 命令、任意 `-o`、ProxyCommand 或轉發旗標。

VPC 位址需要目前電腦已有 VPC／VPN 路徑；私鑰本身不會建立這條路徑。沒有直連路徑時選 **DSW ProxyClient**：填實例 ID、實際區域、SSH 私鑰、AccessKey ID／Secret，使用 STS 時另填 Token。ProxyClient 由工具自動下載並校驗。DSW 必須已啟用 SSH 並裝入對應公鑰；ProxyClient 的 RAM 身分需要 `paidsw:GetToken`。[官方連線說明](https://help.aliyun.com/zh/pai/connect-to-a-dsw-instance-over-ssh)。

初始化會新增獨立的 gVisor 執行環境，建立反向出口通道，執行區域與身份隔離自測並確認測試資源釋放。成功後才啟用伺服器。現有 worker 不會被直接覆寫；中斷的本次安裝可重新驗證。只分配已保留給本服務的資源。GPU 初始化完成表示已配置設備，首次實際 GPU 計算仍需小任務驗收。

目前發布的 rootfs 是 Linux x86_64。Windows／macOS 是工作台，遠端工作節點仍使用 Linux。基礎環境包含 Python／Git／Bash，不包含完整深度學習套件。

## SSH 金鑰

在 Windows PowerShell、Linux 或 macOS 終端執行：

```text
ssh-keygen -t ed25519 -C "starport"
```

按提示選擇路徑與密語。預設公鑰是 `.ssh/id_ed25519.pub`，私鑰是同目錄的 `id_ed25519`。**只把公鑰放到伺服器的 `authorized_keys`。**

Windows 查看公鑰：

```powershell
Get-Content "$env:USERPROFILE\.ssh\id_ed25519.pub"
ssh-keygen -lf "$env:USERPROFILE\.ssh\id_ed25519.pub"
ssh-add "$env:USERPROFILE\.ssh\id_ed25519"
```

若 ssh-agent 尚未啟動，可在系統服務設定啟用 OpenSSH Authentication Agent，或用管理員 PowerShell 執行 `Set-Service ssh-agent -StartupType Automatic` 和 `Start-Service ssh-agent`。私鑰密語由 `ssh-add` 在本機讀取。

從**已有私鑰**取回公鑰：

```text
ssh-keygen -y -f path/to/private_key
```

不能從公鑰還原遺失的私鑰。面板的「查找匹配私鑰」會讀取指定目錄的候選私鑰，提取公鑰後比對；不只信任同名 `.pub`。預設僅搜尋目前使用者 `.ssh` 的第一層，最多 200 個項目，不跟隨符號連結。

受保護目錄可使用「系統授權後查找指定目錄」：Windows UAC、macOS 管理員視窗、Linux Polkit。須先填完整公鑰與確切目錄，成功後僅複製匹配的私鑰到本設定檔的私有目錄。系統密碼不經過網頁，也不儲存。加密金鑰會標記為待解鎖，不把未驗證的 sidecar 當作匹配成功。面板另外提供無密語的部署專用金鑰生成；需要密語時使用上面的指令。

## Cloudflare Token 與登入名單

Token 權限限定在目標帳戶和網域：

| 範圍 | 權限 |
| --- | --- |
| Account | Cloudflare Tunnel Edit |
| Account | Access: Apps and Policies Edit |
| Account | Access: Organizations, Identity Providers, and Groups Read |
| Zone | Zone Read、DNS Edit |

Zero Trust 帳戶需已設定登入方式，例如電子郵件一次性 PIN。工具不更改整個帳戶的登入方法。輸入的是 Cloudflare API Token，不是主帳號密碼或 Global API Key。

每次建立 `console-<隨機後綴>.example.com`，也可填另一個前綴。工具先查 DNS／Access 是否占用，先建可重用的精確信箱允許政策與獨立應用，再驗證來源站已拒絕匿名存取，最後才發布 DNS。連接器使用私有 token 檔案，不把 token 放在程序參數裡。

| 面板 | 允許信箱 |
| --- | --- |
| 你的面板 | 你的信箱 |
| 成員 A 的面板 | 成員 A；如需管理可明確加入你的信箱 |
| 成員 B 的面板 | 成員 B；如需管理可明確加入你的信箱 |

Access 登入權不等於 Cloudflare 管理權。來源站驗證 JWT 簽名、issuer、audience、期限及完整信箱；只偽造 email header 不會通過。遠端「部署與管理」另需本機存取碼。此面板內允許的使用者共享此面板資料；不同人的資料隔離應使用不同 OS 帳戶／設定檔及獨立遠端 worker 帳戶或實例，不能只換網址。

### Agent／CLI 配置

將 `examples/cloudflare.example.json` 複製到私有設定目錄，填入網域與信箱，Token 放在同目錄 `api-token`。POSIX 檔案權限使用 `chmod 600 api-token`。在同一 `STARPORT_PI_STATE` 下啟動面板後執行：

```text
node bin/starport-cloudflare.mjs plan path/to/private-enrollment.json
node bin/starport-cloudflare.mjs apply path/to/private-enrollment.json
node bin/starport-cloudflare.mjs status path/to/private-enrollment.json
```

面板會啟動並維護自己的 cloudflared。單獨連接器也可用 `node bin/starport-cloudflare.mjs start`，需要 PATH 中有 cloudflared 2025.4.0+。不要同時啟動重複連接器。

中斷後 `status` 按本次唯一名稱核對資源，`apply` 接續已完成階段。創建結果不明且無法核對時停止，不盲目重試。`rollback` 只刪除此設定檔記錄且內容仍匹配的資源，先刪 DNS，來源站仍保持 Access 保護；不更改其他控制台。

## 會話、任務、日誌和檔案

會話持續在背景執行，切換頁面不停止任務。思考／工具狀態與已用時間會更新；訊息使用序號增量同步，已有內容保留。Markdown 與命令卡片可直接閱讀。模型產生的命令只走遠端 worker。

「停止回覆」停止模型生成；「取消此任務」只取消指定計算。任務頁提供增量日誌與產物下載，執行中的任務也能讀取 `/output`。檔案頁只讀寫該會話工作區。上傳使用 1 MiB 分塊、整體與分塊 SHA-256，同一瀏覽器分頁重選相同檔案可以接續；檔案內容不保留於瀏覽器儲存。

附加的檔案放入遠端工作區，訊息加入其路徑；本版不把圖片轉成模型視覺內容。網頁不自動載入訊息中的第三方圖片，避免外部追蹤請求。

## 登入後自動啟動

Windows 提供目前使用者的登入啟動工作，不需要儲存系統密碼：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\register-panel.ps1
# 移除本設定檔的啟動工作
powershell -ExecutionPolicy Bypass -File .\scripts\register-panel.ps1 -Remove
```

這是在使用者登入後啟動，並非登入前的 Windows 系統服務。面板重新啟動後會恢復本設定檔的 Mihomo、已驗證伺服器的出口通道及 Cloudflare 連接器。其他設定檔和其他應用的服務不受影響。

代理故障不回退直連；重新連接不會取消訓練。Token 過期、SSH 金鑰更改或 VPC 路徑不可達，仍需在管理頁修正對應設定。

官方依據：[Tunnel API](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel-api/)、[Access 政策](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/)、[JWT 驗證](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)。
