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
| 實際 Linux／DSW | 單獨的小型 CPU 資源驗收，詳見發布時的結果記錄 |

```bash
npm ci --ignore-scripts
npm test
npm run test:server
python3 scripts/audit_source.py
```

`test:server` 使用 Linux 的 flock、affinity 和安全檔案描述符；Windows runner 驗證的是原生客戶端。WSL2 的安裝／重新啟動流程需在實際 Windows 電腦驗收，CI 不會修改虛擬化功能。

GPU 配置程式會核對真實驅動與 gVisor 支援表。完整 GPU 工作負載、特定 AI 框架、圖形渲染及所有 DSW 集群並非已通過項目；先完成各自的小任務驗收，再提供生產工作負載。

測試不使用真實模型 API Key，不把程式測試等同於付費模型的回答品質驗證。
