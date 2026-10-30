# 验证范围

此文件区分可重现测试、实际服务器验收及尚未验收的项目。

| 项目 | 验证方式 |
| --- | --- |
| Windows 原生安装 | GitHub Actions 的 Windows runner 执行 PowerShell 安装器和 Node 测试 |
| Pi 工具边界 | 真实 Pi SDK、模拟模型 stream，核对工具只呼叫远端 RPC、context 不含操作端路径 |
| 模型出口 | 真实 Pi provider transport 在代理不可用时失败，禁止直连 fallback |
| 订阅／节点切换 | YAML／URI、TLS 与脚本拒绝测试；私有 controller 的重载测试 |
| 文件／资料 | traversal、symlink、FIFO、分块续传、收据恢复、版本不变性 |
| 服务调度 | CPU／内存预留、工作区互斥、取消范围、遗失 controller 与静默任务区分 |
| 实际 Linux／DSW | 独立 CPU 资源上完成区域设置、文件哈希、只读资料、HTTPS、代理中断及取消回收测试 |

2026-10-30 的已完成验收收录于 [validation.json](validation.json)：

- 台北时区、繁体 locale、UTF-8、三类 Noto CJK TC 字型通过。
- 上传文件与下载结果 SHA-256 一致；资料版本不随项目改动，任务内写入被拒绝。
- 宿主路径与操作端凭证环境不可见，直接网路连线被封锁。
- 经所选代理的 HTTPS 回传 200；停止独立测试代理后，任务外网请求失败。
- 静默任务保持执行；明确取消后确认资源释放。
- Windows 原生 PowerShell 安装器及 Linux CI 均通过；20 项程式测试通过。

测试只使用自建工作区及专用预留，没有重启既有服务或修改原有依赖环境。

```bash
npm ci --ignore-scripts
npm test
npm run test:server
python3 scripts/audit_source.py
```

`npm test` 验证 Windows／Linux／macOS 原生客户端。`test:server` 使用 Linux 的 flock、affinity 和安全文件描述符，只在 Linux 执行；Windows／macOS 会清楚输出 SKIP，直接使用 Python unittest discovery 也会略过。略过不代表 worker 已通过，远端执行器仍须在 Linux 验证。不要在 Windows 安装替代 `fcntl` 或移除文件锁。

Windows CI 同时测试 Windows PowerShell 5.1 与 PowerShell 7 的 PATH 合并，重现并防止刷新后遗失仅存在于目前 shell 的 Node／npm／SSH 路径。卸载测试以模拟程序验证预览不修改状态、只停止本设置档的程序、保留私有资料，以及拒绝回收后重用的 PID。

WSL2 的安装／重新启动流程需在实际 Windows 电脑验收，CI 不会修改虚拟化功能。

GPU 配置程式会核对真实驱动与 gVisor 支援表。完整 GPU 工作负载、特定 AI 框架、图形渲染及所有 DSW 集群并非已通过项目；先完成各自的小任务验收，再提供生产工作负载。

测试不使用真实模型 API Key，不把程式测试等同于付费模型的回答品质验证。

## v0.2 网页与部署向导

新增验证覆盖 Access JWT、跨站写入拒绝、不同会话的上传权限、SSH 指令解析、私钥匹配，以及初始化必须同时通过隔离自测和资源回收。Cloudflare API 使用模拟回应核对创建顺序、未知结果接续与只删除本次资源；不使用个人帐户建立测试入口。

浏览器实测了桌面与手机布局、会话读取／发送、工具卡片、订阅文本导入、文件分块上传与下载。1,520,000 bytes 的同一文件回传 SHA-256 完全一致。会话模型使用真实 Pi SDK 加固定测试 stream，远端使用测试 worker adapter；这不是一次付费模型或新 DSW 的生产验收。

Windows、Linux、macOS 客户端纳入 CI。Windows 执行原生 PowerShell 安装器、网页建置、Node 测试与所有 PowerShell 脚本语法检查；CI 不会弹 UAC、变更登入启动工作或购买资源。首次部署仍需用使用者的实际连线完成指纹核对、远端隔离自测及 Cloudflare 登入验收。管理员弹窗的互动流程须在有桌面的目标系统完成验收。

## v0.3 configuration and local execution

Tests cover authenticated encrypted exports, wrong passwords and tampering,
portable private paths, fresh-profile-only import, and rejection of partial
invalid configuration. Conversation-only sessions use the actual Pi SDK with
zero tools; neither project files nor operator context are exposed.

The local bridge is exercised with a real Python process and Unix socket on
Linux, streaming 2 MiB through a fixed loopback peer and closing on channel loss.
Portable import-image tests verify first-boot WSL automount and interop settings.
These tests do not run a Windows hypervisor. WSL2 import, gVisor execution and
resource limits must pass the built-in probe on the actual Windows computer;
unverified local runtimes remain disabled.

Browser verification for v0.3 covered conversation-only creation, model selection,
encrypted download, decrypted preview and import into an empty profile. Imported
servers remain disabled pending verification. Desktop 1280×720 and mobile
390×844 layouts were checked; no horizontal overflow was present. A stale lazy
module after rebuilding was found and given an explicit reload fallback.

Local test results: 23 Node tests and 11 Python tests passed. Platform-specific
WSL bridge tests run only on Linux; Windows and macOS skips are not execution
acceptance.

## v0.3.1 connection repair

Regression coverage includes ProxyCommand executable names versus complete
instance arguments and `%h`, conflicting identities, invalid placeholder IDs,
retained configuration during repair, refusal to change initialized or used
connections, missing imported scan directories, and sanitized ProxyClient error
classification. Shape checks do not prove that an instance exists: actual
exports must also be checked with cloud GetInstance and SSH before delivery.

Local v0.3.1 checks: 25 Node tests and 13 Python tests passed. The browser
connection-update flow changed a deliberately invalid fixture ID while retaining
its uninitialized state and existing settings. Deployment-specific validation
records remain private and are not part of this public repository.

## v0.3.2 resumable installation downloads

The installer shares one downloader for rootfs, gVisor and tools. Tests exercise
real HTTP streams with an interrupted body, a retained legacy partial file,
Range/If-Range, a server ignoring Range, an invalid Content-Range, checksum
failure, renewed signed redirects, idle timeout, continuous slow progress,
concurrent-cache exclusion, cache reuse and precise safe error codes. Proxy
configuration remains the same across retries. A failed state-file write does
not crash the panel or erase an already classified download error.

A live Linux download through an existing loopback proxy resumed the public
v0.1.0 rootfs at byte 111253913 (106.1 MiB). The release CDN returned HTTP 206,
transferred only the remaining 53914995 bytes, and produced the expected
165168908-byte file with the pinned SHA-256. The test cache was removed after
verification. This validates download/resume, not installation on another host.

Local checks passed: 36 Node tests, 13 Python tests, web build and publication
audit. Browser checks used fixture operation records to verify retry counts,
saved bytes, a specific disk-space error, and automatic transition to resumed
progress. Desktop and 390×844 mobile layouts had no framework error overlay,
console errors or horizontal overflow. The fixture did not initialize a server.

## v0.3.3 local and Cloudflare request origins

An HTTP regression test reproduced `origin_not_allowed` when a local session
continued after Access enrollment. The fix verifies the request's exact entry
point: loopback Host plus loopback peer without forwarding headers for local
login, and the configured public Host plus Access JWT for remote access. CSRF
and exact-Origin checks remain required for writes; remote setup also requires
the operator key. Local cookies and forged forwarding headers cannot substitute
for a valid Access JWT on the public entry.

Tests cover the existing local session, login after restart, expired/wrong
audience/wrong email/invalid signature JWT rejection, and continuation after an
unknown Tunnel creation outcome without duplicate resources. The deployment
probe uses the public Host over a fixed loopback connection, and Tunnel ingress
pins that Host. A browser fixture verified the actual Apply button, transition
to configured state, and subsequent local state refresh without a login or
origin error. Cloudflare API calls and the connector were simulated; no real
account resources or existing console were changed for this check.

Local checks: 40 Node tests, 13 Python tests, web build and publication audit
passed. Desktop browser page identity, rendered content, interaction and console
checks passed with no framework error overlay.

## Native tools and extensions (0.4.0)

The real Pi SDK was exercised against deterministic Anthropic SSE fixtures:
server tool blocks, citations, pause/resume, the following user turn and a disk
reload retain the provider content. Tests check that replay markers, operator
paths and account response headers do not enter public views. Advisor iterations
are counted once; cache prices use the model's actual read rate. The Files API
fixture checks multipart upload and reuse of an existing file ID.

The HTTP checks cover authenticated attachment upload/download, whole-file and
chunk hashes, retrying an acknowledged chunk, Range responses and rejection of
another session's grant. Existing proxy-failure and zero-local-tool checks pass.
Skills and MCP require explicit selection; plugin imports cannot run host code.
The operator tools and worker processes were not restarted for these tests.

Browser validation used an independent loopback panel with synthetic model and
worker data: Markdown table/task-list/math/code rendering, Simplified display
of Traditional transcript text, conversion before sending, the slash palette,
capability settings, Skill creation, MCP configuration fields, attachment
upload/preview/download and usage display. Both desktop and a 390 × 844 mobile
viewport were checked. The downloaded PNG's SHA-256 matches its uploaded source.
These checks do not represent paid API account eligibility, real MCP service
acceptance, cloud code execution or fast-mode throughput measurements.

PDF preview uses the bundled PDF.js worker rather than browser PDF plugins.
A one-page PDF was rendered to canvas, and an MP4 reached decoded media state
with the expected one-second duration. Character maps and standard fonts are
served locally. A stale lazy-loaded bundle during the intentional QA rebuild
showed a reload action; refreshing restored the panel instead of leaving a blank
page. Local validation finished with 49 Node tests, 13 Python tests, a production
build, a clean publication audit and no production npm audit findings.

## Session management and empty tool arguments (0.4.1)

The native collector preserves initial tool input when argument deltas are empty
or whitespace. Non-empty malformed JSON remains an error. Regression tests cover
ordinary, hosted and MCP tools, plus the real Pi SDK calling `server_status`
through deterministic SSE and continuing after its remote health result. No paid
model requests were sent, and no failed user request was replayed.

Session metadata persists project groups, titles and archive state across
restart. HTTP tests verify CSRF, archived-send rejection, read-only history access,
deletion confirmation, active-turn/unreleased-job guards, in-flight file request
exclusion, and cleanup restricted to the deleted session's local data. Deferred
cleanup is retried at startup. Remote workspaces and jobs are never deleted or
cancelled by session management.

An independent loopback fixture was checked at 1280 × 720 and 390 × 844: grouped
creation, rename/move, search, project folding, archive/reload/restore, deletion
confirmation and cancellation. Settings collapse to 38 pixels, retain drafts
when folded, close after applying, and open through `/tools`. Mobile expansion
keeps the composer visible. Both layouts had no horizontal overflow, framework
overlay or browser console errors. Permanent deletion was verified through the
HTTP tests with disposable data, not on user conversations.

Local checks: 53 Node tests, 13 Python tests, production web build and source
privacy audit passed. These checks do not initialize servers or restart existing
installations. The build retains the existing size warning for lazy PDF/Markdown
chunks.
