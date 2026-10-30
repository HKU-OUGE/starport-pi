---
name: starport-setup
description: Install and configure Starport Pi on Windows, Linux, or macOS; connect an existing Linux or Alibaba DSW worker; enroll a private web endpoint with Cloudflare Tunnel and per-user Access. Use for operator-side setup and validation, not for executing project commands locally.
---

# Starport Pi setup

Operate from the repository root. This skill is for the **trusted installation
agent on the operator computer**. The coding model inside Pi must not receive
this operator capability, cloud credentials, or local command tools.

Read only the guide needed for the current stage:

- Native Windows or optional WSL2: [Windows](../../docs/WINDOWS.md).
- Subscription, SSH/DSW, rootfs, GPU: [Setup](../../docs/SETUP.md).
- Jobs, transfers, datasets: [Usage](../../docs/USAGE.md).
- Remote hostnames and account permissions: [Remote access](../../docs/REMOTE_ACCESS.md).
- Boundary and resource limits: [Security](../../SECURITY.md).

## Establish the intended deployment

Inspect existing configuration and running services before installing anything.
Use `STARPORT_PI_STATE` for a deliberate separate profile; otherwise use the OS
user data directory selected by `src/config.mjs`. Do not copy a private profile
into the source tree.

Collect only missing inputs: operating system, existing SSH alias or DSW ID and
actual region, private key/ProxyClient configuration **file locations**, resource
budget, subscription file/URL, and API key file or hidden-input authentication.
Do not ask users to paste keys into chat. Keep commands, reports and screenshots
free of secret values.

For remote web access, also collect the Cloudflare zone, allowed login emails,
API-token file, and intended per-user profile. A hostname alone does not specify
who is authorized. A user's prior explicit deployment instruction is sufficient
authorization within that scope; present the concrete plan if authorization is
still missing.

## Install the operator workbench

1. Prefer native Windows. Run `scripts/install.ps1` in PowerShell; it opens the web
   setup wizard at loopback port 18900 after installation. It installs or
   checks Node.js/Python/OpenSSH and verifies the client. On Linux/macOS run
   `bash scripts/install.sh`. Use `scripts/setup-wsl.ps1` only if WSL2 is requested.
2. Prefer the web deployment wizard for subscription, SSH/DSW, key matching and
   Cloudflare inputs. `node bin/starport-pi.mjs configure` also handles server profiles,
   model and effort. `auth` provides hidden API-key input. Do not auto-load local
   Pi extensions, MCP tools, skills, AGENTS files, or a local shell into sessions.
3. Import the subscription through the existing parser; retain supported protocol
   options such as SS obfs, but do not import provider routing or DIRECT fallbacks.
   Select a node and apply it. Never replace another application's system proxy.
4. Run `node bin/starport-pi.mjs verify-server`. Verify a new host fingerprint
   against the server; do not disable strict host-key checking to fix a mismatch.

## Install the worker additively

1. Use an existing authorized Linux/DSW instance. New paid instances require an
   explicit request. The DSW actual region is operator metadata, independent of
   the guest's Taipei locale.
2. Download the release rootfs and verify its SHA-256. In the console use
   `/install-server`; the operator downloads and verifies the full gVisor bundle
   through the selected proxy, then uploads it. Never copy `runsc` without its
   matching `gvisor-bin` sidecars.
3. Allocate CPU and memory from confirmed available resources. If the host is
   shared, explicitly reserve non-overlapping resources in its existing scheduler.
   A free GPU memory reading is not evidence that another scheduler has not
   reserved the device. `/gpu` checks compatibility before enabling selected GPUs.
4. An existing worker directory is a stop-and-inspect condition, not permission
   to overwrite it. Do not restart DSW, replace its dependencies or cancel jobs
   merely to finish installation.
5. Create `/workspace`, connect `/tunnel`, then run `node bin/starport-pi.mjs probe`.
   Read the returned job's final status and logs. Only `passed: true` together
   with confirmed release is regional-profile acceptance.

## Validate the complete path

Use a small owned CPU job first. Check project write/read, a Unicode filename,
read-only dataset access, an output download and matching SHA-256. Verify the
profile: Asia/Taipei, zh_TW.UTF-8, UTF-8, Noto CJK TC, neutral hostname and empty
machine ID. The task must not see operator paths or credentials.

Test proxy failure using an independent test proxy/tunnel, not by stopping an
active user's router. Verify direct networking remains blocked. A quiet task
must stay alive; cancel only the test job and confirm its resource release.
Run a small GPU job only after an authorized reservation is available. Report
CPU acceptance, GPU compatibility, real GPU execution and model API usage
separately; do not turn a mock test into a production claim.

## Enroll remote access

Use the plan/apply/status commands in [Remote access](../../docs/REMOTE_ACCESS.md).
The reusable Access allow policy and exact-host application must exist before
DNS exposure. Do not grant Everyone, Bypass, all valid emails or a whole email
domain when a list of people was requested. Avoid wildcard applications.

Allocate a fresh `console-<suffix>` hostname after checking DNS and Access apps.
Do not replace an existing console. Each user needs a separate panel state and
an authorized worker/account; separate hostnames alone do not isolate shared
backend data. Verify signed Access JWT issuer, audience, expiry and allowed email
at the origin. An email header alone is not authentication.

Use the private receipt to resume after an interrupted operation. Do not repeat
a timed-out resource creation blindly. Rollback may delete only resource IDs
recorded for this enrollment, after checking they still match the receipt.

Validate anonymous denial, allowed-user success, another user's denial and
cross-host JWT rejection. A healthy tunnel is not evidence of correct Access
permissions. When credentials or a real login are unavailable, finish local
code/tests and state which live checks remain.

## Deliver

Give the user the entry URL, installation/usage guide, exact validation status
and any remaining action. Include a redacted resource receipt, not secrets.
Keep rootfs/source/runtime artifacts distinct. Clean only this setup's temporary
files and reservations after confirmed transfer or completion; preserve existing
jobs, results, environments and policies.
