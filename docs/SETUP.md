# 安裝與配置

## 1. 工作台

Windows 使用 `scripts/install.ps1`；Linux／macOS 使用 `scripts/install.sh`。完成後執行 `node bin/starport-pi.mjs configure`。

訂閱選單支援 Clash／Mihomo YAML，以及 SS、VMess、VLESS、Trojan URI 列表和 Base64 列表；接受 TCP、WebSocket、gRPC，以及 SS 的內建 obfs／v2ray-plugin 選項。從 [Mihomo 官方發布](https://github.com/MetaCubeX/mihomo/releases)取得對應系統的執行檔，在選單填入路徑。

選擇節點後執行「啟動／套用出口」。使用獨立的 loopback 代理與帶隨機密鑰的管理端口；不接管既有系統代理。更新 HTTPS 訂閱後再次套用。提供者的 routing、DIRECT fallback、腳本和公開監聽設定不會直接匯入。

API Key 透過 `node bin/starport-pi.mjs auth` 的隱藏輸入保存。聊天內容只交給設定的模型；訂閱與伺服器設定選單不進入會話。

## 2. 連接既有伺服器

伺服器需要 Linux 5.6+、Python 3.10+、SSH、可用的 user namespace，以及 gVisor 所需的系統呼叫。一般 Linux、ECS 或 DSW 均可先驗證；外層平台若禁止必要功能，安裝或驗證會報錯，不會降級成宿主 shell。

一般 SSH：先建立自己的 SSH 別名，在 `/servers` 新增它。

阿里 DSW：

1. 按[官方 ProxyClient 指引](https://help.aliyun.com/zh/pai/connect-to-a-dsw-instance-over-ssh)下載 Windows／Linux／macOS 版本。
2. 在操作端執行 `proxyclient config`（Windows 為 `proxyclient.exe config`），建立私有設定。使用自己的 RAM／STS 憑證；連線需要 `paidsw:GetToken` 及 SSH 金鑰。STS 到期需由操作端更新。
3. 在實例中配置自己的 SSH 公鑰。現有 SSH 已正常時直接復用，不需重啟。
4. 在 `/servers` 選擇阿里 DSW，填入實際區域、實例 ID、ProxyClient、憑證檔和 SSH 私鑰路徑。可參考 `examples/connection.example.json` 的欄位。
5. 執行 `/verify-server`，與伺服器端顯示的 SSH 指紋核對後接受。後續連線固定使用嚴格主機金鑰驗證。

上述管理資料只存於操作端。模型看見的是公開別名、可用資源及專案路徑。

## 3. 建立遠端執行環境

從本倉庫的 Release 下載 `rootfs.tar.gz` 及校驗檔，或在有 Podman／Docker 的 Linux 建置機產生：

```bash
bash scripts/build-rootfs.sh
# 若使用 Docker：CONTAINER_ENGINE=docker bash scripts/build-rootfs.sh
```

建置只需做一次。Windows 使用者可直接使用已發布的 rootfs，不需安裝 Docker 或 WSL。

在工作台執行 `/install-server`，選擇 rootfs 並設定 CPU／記憶體預算。安裝器：

- 驗證傳輸 SHA-256，安全解包乾淨 rootfs。
- 操作端經所選代理下載固定版本的 gVisor 完整套件，驗證 SHA-512，再經 SSH 上傳；伺服器不需要直連下載站。保留 runsc 和配套 sidecar。
- 新增使用者專屬目錄，記錄 runtime 雜湊；不修改原有 Python 環境、Docker、SSH 或其他服務。
- 已存在安裝時拒絕覆蓋，避免影響執行中的任務。

需要離線 runtime 時，管理員可在伺服器使用下列方式；指定的 `runsc` 旁必須有同一版本的 `gvisor-bin`：

```bash
python3 server/install.py --rootfs rootfs.tar.gz --sha256 EXPECTED_SHA256 \
  --runsc ./gvisor/runsc --runsc-sha256 EXPECTED_RUNSC_SHA256 \
  --cpus 8 --memory-gib 32
```

已有其他工作負載時，優先使用專用實例；若共用，使用 `--cpu-indices` 配置不重疊的 CPU，並事先保留相應記憶體。此工作台不讀取第三方排程器的預留表。

## 4. 驗收與 GPU

```text
/workspace
/tunnel
```

另開終端執行 `node bin/starport-pi.mjs probe`，再讓模型查看返回任務的日誌；應包含 `passed: true`。檢查涵蓋台北時區、繁體 locale、UTF-8、TC 字型、機器標識與直接網路封鎖。

GPU 是可選能力。`/gpu` 先核對驅動與 gVisor 的精確版本相容性，再由操作人員確認 GPU 已專門分配給此服務。只掛載經雜湊核對的 CUDA／NVML 使用者庫和所選裝置，不掛載宿主的整個 `/usr` 或 `/sys`。不支援的驅動會拒絕啟用，不自動安裝或修改驅動。GPU smoke command 是 `python3 /opt/starport/gpu_probe.py`，提交時指定 `gpus: 1`。

基礎 rootfs 提供 Python、Git、Bash 和字型；PyTorch／Isaac Lab 等應用依賴不包含在內，可透過受控出口在 `/workspace/.venv` 安裝，或由管理員建置專用乾淨 rootfs。[gVisor GPU 支援範圍](https://gvisor.dev/docs/user_guide/gpu/)應與實際驅動一併驗證。
