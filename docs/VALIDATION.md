# 驗證範圍

此文件區分可重現測試、實際伺服器驗收及尚未驗收的項目。

| 項目 | 驗證方式 |
| --- | --- |
| Windows 原生安裝 | GitHub Actions 的 Windows runner 執行 PowerShell 安裝器和 Node 測試 |
| Pi 工具邊界 | 真實 Pi SDK、模擬模型 stream，核對工具只呼叫遠端 RPC、context 不含操作端路徑 |
| 模型出口 | 真實 Pi provider transport 在代理不可用時失敗，禁止直連 fallback |
| 訂閱／節點切換 | YAML／URI、TLS 與腳本拒絕測試；私有 controller 的重載測試 |
| 檔案／資料 | traversal、symlink、FIFO、分塊續傳、收據恢復、版本不變性 |
| 服務調度 | CPU／記憶體預留、工作區互斥、取消範圍、遺失 controller 與靜默任務區分 |
| 實際 Linux／DSW | 獨立 CPU 資源上完成區域設定、檔案哈希、只讀資料、HTTPS、代理中斷及取消回收測試 |

2026-10-30 的已完成驗收收錄於 [validation.json](validation.json)：

- 台北時區、繁體 locale、UTF-8、三類 Noto CJK TC 字型通過。
- 上傳檔案與下載結果 SHA-256 一致；資料版本不隨專案改動，任務內寫入被拒絕。
- 宿主路徑與操作端憑證環境不可見，直接網路連線被封鎖。
- 經所選代理的 HTTPS 回傳 200；停止獨立測試代理後，任務外網請求失敗。
- 靜默任務保持執行；明確取消後確認資源釋放。
- Windows 原生 PowerShell 安裝器及 Linux CI 均通過；20 項程式測試通過。

測試只使用自建工作區及專用預留，沒有重啟既有服務或修改原有依賴環境。

```bash
npm ci --ignore-scripts
npm test
npm run test:server
python3 scripts/audit_source.py
```

`test:server` 使用 Linux 的 flock、affinity 和安全檔案描述符；Windows runner 驗證的是原生客戶端。WSL2 的安裝／重新啟動流程需在實際 Windows 電腦驗收，CI 不會修改虛擬化功能。

GPU 配置程式會核對真實驅動與 gVisor 支援表。完整 GPU 工作負載、特定 AI 框架、圖形渲染及所有 DSW 集群並非已通過項目；先完成各自的小任務驗收，再提供生產工作負載。

測試不使用真實模型 API Key，不把程式測試等同於付費模型的回答品質驗證。
