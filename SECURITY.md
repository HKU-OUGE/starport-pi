# 隔離邊界

Starport Pi 把操作端、控制通道、模型工具與執行環境分開。信任操作人員、Pi／Node.js 套件、SSH、gVisor 和伺服器管理員；把模型生成的命令及專案內容視為不可信。

| 邊界 | 實作 |
| --- | --- |
| 本機命令 | 不向模型註冊本機 Bash、檔案系統、設定或安裝工具；不自動載入專案 extension、MCP、skill、AGENTS 或本機 context |
| SSH／雲憑證 | 留在操作端；固定 RPC 命令，無 Agent forwarding，嚴格 host-key 驗證，連線錯誤不回傳管理資訊 |
| 宿主檔案 | 乾淨唯讀 rootfs；只掛當前 workspace、當前 output、明確選定的只讀資料及單一出口 socket |
| 程序與網路 | gVisor 的獨立 PID／IPC／UTS／network 視圖，`--network=none`，無 capabilities，no-new-privileges |
| 外網 | guest loopback HTTP → 單一 Unix socket → SSH 反向轉發 → 操作端 Mihomo → 選定節點；沒有 DIRECT fallback |
| API | 只能透過 loopback 代理連接 Anthropic HTTPS API；代理失效即失敗 |
| 區域設定 | 台北時區、繁體 locale、UTF-8、TC 字型；清空 machine-id 和 boot-id，固定 hostname |
| 檔案操作 | descriptor-relative 路徑、拒絕 traversal／symlink／特殊檔案，分塊及整檔雜湊 |

rootless 單 UID 映射使用 **guest UID 0** 讓持久化 bind 目錄可寫；它不具有宿主 root 檔案系統或 Linux capabilities。任務不能掛入新的宿主目錄、讀取控制服務設定或進入另一個任務。

控制通道不經模型訂閱代理，這是操作端連接阿里 API／SSH 所需的管理流量。任務無法取得這些連線憑證、管理主機地址或切換出口。訂閱下載和執行檔安裝同樣是人工操作，不屬於模型工具。

## 資源與相容性

CPU 使用互不重疊的 affinity 預留，記憶體使用服務預算、MemAvailable 檢查及執行時 RSS 監測。外層 DSW 的硬限制仍有效；RSS 輪詢不是 cgroup 硬記憶體／程序數／磁碟配額，不適合把同一服務直接開放給互不信任的多租戶。部署到專用實例，或由上層提供 cgroup 與磁碟 quota。

GPU 使用 gVisor nvproxy，限定裝置和驅動庫，核對精確驅動版本。GPU 型號、驅動資訊和 CUDA 可讀的 GPU UUID 可能對程式可見；此版不承諾隱藏 GPU UUID。啟用前需人工保留 GPU，當下顯存閒置不代表其他排程器沒有預留。

SSH 連線帳號是可信管理帳號。多名不互信的使用者應使用不同 worker／實例和金鑰；資料 ID 不是跨使用者授權系統。不要讓模型載入操作端 extension，或給它另一個能在操作端執行命令的工具。

地域設定不會變更實體位置、網路地理位置、帳號所屬地區或供應商的使用資格。這是工作環境一致性與資料隔離工具，並不提供帳號風險保證。

## 公開版本

`python scripts/audit_source.py` 掃描候選檔案中的真實路徑、AccessKey、私鑰、個人郵件、執行期目錄和大型產物。設定及訂閱位於作業系統使用者資料目錄，Windows 使用 ACL、POSIX 使用 0700／0600。不要將操作端私有 state 目錄加入 Git。

上游參考：[Pi](https://github.com/earendil-works/pi)、[gVisor 安裝](https://gvisor.dev/docs/user_guide/install/)、[rootless](https://gvisor.dev/docs/user_guide/rootless/)、[GPU](https://gvisor.dev/docs/user_guide/gpu/)、[Mihomo API](https://wiki.metacubex.one/en/api/)。
