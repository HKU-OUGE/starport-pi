import React, { useEffect, useState } from "react";
import { setup, setAdmin } from "./api";

const initialServer = {
  name: "server-alpha",
  mode: "ssh",
  command: "",
  privateKey: "",
  cpus: 4,
  memoryGiB: 8,
  gpuText: "",
  instanceId: "",
  region: "",
  accessKeyId: "",
  accessKeySecret: "",
  stsToken: "",
  user: "root",
};
function Field({ label, children }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}
function Input({ label, type = "text", ...props }) {
  return (
    <Field label={label}>
      <input type={type} {...props} />
    </Field>
  );
}
export default function Setup({ onClose, onChange, guideOnly = false }) {
  const [tab, T] = useState(guideOnly ? "guide" : "network"),
    [state, S] = useState(null),
    [error, E] = useState(""),
    [busy, B] = useState(false),
    [result, R] = useState(null),
    [admin, A] = useState("");
  const [sub, Sub] = useState({ label: "My subscription", url: "", text: "" }),
    [node, N] = useState(""),
    [server, V] = useState(initialServer),
    [selected, Q] = useState(""),
    [keys, K] = useState([]),
    [pub, P] = useState(""),
    [dir, D] = useState(""),
    [cf, C] = useState({ zone: "", prefix: "console", emails: "", token: "" }),
    [model, M] = useState({ model: "claude-sonnet-5-5", apiKey: "" });
  const refresh = () =>
    setup("state")
      .then((s) => {
        S(s);
        N((n) => n || s.selectedNode || "");
      })
      .catch((e) => E(e.message));
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, []);
  async function run(action, data) {
    E("");
    B(true);
    R(null);
    try {
      const value = await setup(action, data);
      R(value);
      await refresh();
      onChange?.();
      return value;
    } catch (e) {
      E(e.message);
    } finally {
      B(false);
    }
  }
  const update = (name, value) => V((v) => ({ ...v, [name]: value }));
  const disabled =
    busy || state?.operations.some((o) => o.status === "running");
  const lastScan = state?.operations.find(
    (o) =>
      o.kind === "server-scan" &&
      o.status === "complete" &&
      o.result?.name === selected,
  )?.result;
  return (
    <section className="settings">
      <div className="view-heading">
        <div>
          <div className="eyebrow">MISSION CONTROL</div>
          <h1>部署與管理</h1>
        </div>
        <button onClick={onClose}>返回工作台</button>
      </div>
      <nav className="tabs" aria-label="管理分類">
        {[
          ["network", "01 訂閱與出口"],
          ["servers", "02 伺服器"],
          ["access", "03 遠端入口"],
          ["model", "模型"],
          ["keys", "SSH 金鑰"],
          ["guide", "指引"],
        ].map(([id, label]) => (
          <button
            key={id}
            className={tab === id ? "active" : ""}
            onClick={() => T(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      {error === "operator_key_required" && (
        <form
          className="card"
          onSubmit={(e) => {
            e.preventDefault();
            setAdmin(admin);
            A("");
            E("");
            refresh();
          }}
        >
          <h2>解鎖管理功能</h2>
          <Input
            label="本機啟動視窗中的管理存取碼"
            type="password"
            value={admin}
            onChange={(e) => A(e.target.value)}
          />
          <button className="primary">解鎖</button>
        </form>
      )}
      {error && (
        <div role="alert" className="error">
          {error}
        </div>
      )}
      {tab === "network" && (
        <div className="settings-grid">
          <form
            className="card"
            onSubmit={async (e) => {
              e.preventDefault();
              const r = await run("network-import", sub);
              if (r) Sub({ ...sub, url: "", text: "" });
            }}
          >
            <h2>匯入訂閱</h2>
            <Input
              label="名稱"
              value={sub.label}
              onChange={(e) => Sub({ ...sub, label: e.target.value })}
            />
            <Input
              label="HTTPS 訂閱網址"
              type="password"
              autoComplete="off"
              value={sub.url}
              onChange={(e) => Sub({ ...sub, url: e.target.value })}
            />
            <details>
              <summary>或貼上 YAML／節點清單</summary>
              <textarea
                rows="5"
                aria-label="訂閱內容"
                value={sub.text}
                onChange={(e) => Sub({ ...sub, text: e.target.value })}
              />
            </details>
            <button className="primary" disabled={disabled}>
              匯入節點
            </button>
          </form>
          <div className="card">
            <h2>選擇出口</h2>
            <Field label="節點">
              <select value={node} onChange={(e) => N(e.target.value)}>
                <option value="">選擇節點</option>
                {state?.nodes.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.subscription} / {n.label}
                  </option>
                ))}
              </select>
            </Field>
            <button
              className="primary"
              disabled={disabled || !node}
              onClick={() => run("network-apply", { node })}
            >
              套用並啟動
            </button>
            <div className="status-line">
              <i className={"dot " + (state?.proxy?.running ? "ok" : "")} />
              {state?.proxy?.running ? "代理已運作" : "尚未啟動"}
            </div>
            {state?.subscriptions.map((s) => (
              <div className="list-row" key={s.id}>
                <span>{s.label}</span>
                <button
                  disabled={disabled}
                  onClick={() => run("network-refresh", { id: s.id })}
                >
                  更新
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      {tab === "servers" && (
        <div className="settings-grid">
          <form
            className="card"
            onSubmit={async (e) => {
              e.preventDefault();
              const data = {
                ...server,
                gpus: server.gpuText
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean)
                  .map(Number),
              };
              delete data.gpuText;
              const r = await run("server-add", data);
              if (r) {
                Q(r.name);
                V(initialServer);
                await run("server-scan", { name: r.name });
              }
            }}
          >
            <h2>新增伺服器</h2>
            <Input
              label="公開別名"
              value={server.name}
              onChange={(e) => update("name", e.target.value)}
              required
            />
            <Field label="連線方式">
              <select
                value={server.mode}
                onChange={(e) => update("mode", e.target.value)}
              >
                <option value="ssh">VPC／SSH 指令</option>
                <option value="dsw">阿里 DSW ProxyClient</option>
              </select>
            </Field>
            {server.mode === "ssh" ? (
              <Input
                label="SSH 指令"
                placeholder="ssh -p 22 worker@host"
                value={server.command}
                onChange={(e) => update("command", e.target.value)}
                required
              />
            ) : (
              <>
                <Input
                  label="實例 ID"
                  value={server.instanceId}
                  onChange={(e) => update("instanceId", e.target.value)}
                  required
                />
                <Input
                  label="實際區域 ID"
                  value={server.region}
                  onChange={(e) => update("region", e.target.value)}
                  required
                />
                <Input
                  label="SSH 使用者"
                  value={server.user}
                  onChange={(e) => update("user", e.target.value)}
                />
                <Input
                  label="AccessKey ID"
                  type="password"
                  value={server.accessKeyId}
                  onChange={(e) => update("accessKeyId", e.target.value)}
                  required
                />
                <Input
                  label="AccessKey Secret"
                  type="password"
                  value={server.accessKeySecret}
                  onChange={(e) => update("accessKeySecret", e.target.value)}
                  required
                />
                <Input
                  label="STS Token（選填）"
                  type="password"
                  value={server.stsToken}
                  onChange={(e) => update("stsToken", e.target.value)}
                />
              </>
            )}
            {server.keyId ? (
              <p className="success">
                已選擇本機匹配金鑰{" "}
                <button type="button" onClick={() => update("keyId", null)}>
                  更換
                </button>
              </p>
            ) : (
              <>
                <Field label="SSH 私鑰">
                  <textarea
                    rows="3"
                    autoComplete="off"
                    spellCheck="false"
                    value={server.privateKey}
                    onChange={(e) => update("privateKey", e.target.value)}
                    placeholder="貼上私鑰，或選取檔案"
                  />
                </Field>
                <input
                  type="file"
                  aria-label="選取私鑰檔案"
                  onChange={async (e) => {
                    if (e.target.files[0])
                      update("privateKey", await e.target.files[0].text());
                    e.target.value = "";
                  }}
                />
                <button type="button" onClick={() => T("keys")}>
                  查找匹配的私鑰
                </button>
              </>
            )}
            <div className="form-row">
              <Input
                label="CPU 核心預算"
                type="number"
                min="1"
                max="512"
                value={server.cpus}
                onChange={(e) => update("cpus", Number(e.target.value))}
              />
              <Input
                label="記憶體 GiB"
                type="number"
                min="2"
                value={server.memoryGiB}
                onChange={(e) => update("memoryGiB", Number(e.target.value))}
              />
            </div>
            <Input
              label="專用 GPU 編號（逗號分隔；留空為 CPU）"
              value={server.gpuText}
              onChange={(e) => update("gpuText", e.target.value)}
            />
            <button className="primary" disabled={disabled}>
              新增並測試連線
            </button>
          </form>
          <div className="card">
            <h2>伺服器初始化</h2>
            {state?.servers.map((s) => (
              <button
                key={s.name}
                className={
                  "server-row " + (selected === s.name ? "selected" : "")
                }
                onClick={() => Q(s.name)}
              >
                <span>
                  {s.name}
                  <small>
                    {s.budget
                      ? `${s.budget.cpus} CPU · ${s.budget.memoryGiB} GiB`
                      : s.mode}
                  </small>
                </span>
                <span className="badge">
                  {s.initialized ? "已啟用" : "待初始化"}
                </span>
              </button>
            ))}
            {selected &&
              !state?.servers.find((s) => s.name === selected)?.initialized && (
                <>
                  <button
                    disabled={disabled}
                    onClick={() => run("server-scan", { name: selected })}
                  >
                    重新測試連線
                  </button>
                  {lastScan && (
                    <div className="verification">
                      <h3>核對 SSH 主機指紋</h3>
                      <code>{lastScan.fingerprints.join("\n")}</code>
                      <button
                        className="primary"
                        disabled={disabled}
                        onClick={() =>
                          run("server-initialize", {
                            name: selected,
                            fingerprint: lastScan.fingerprints[0],
                          })
                        }
                      >
                        指紋正確，初始化環境
                      </button>
                    </div>
                  )}
                </>
              )}
            <p>
              初始化包含執行環境、出口通道與隔離自測。驗證通過後才可建立會話。
            </p>
          </div>
        </div>
      )}
      {tab === "access" && (
        <div className="settings-grid">
          <form
            className="card"
            onSubmit={async (e) => {
              e.preventDefault();
              const r = await run("cloudflare-plan", {
                ...cf,
                emails: cf.emails.split(/[\s,;]+/).filter(Boolean),
              });
              if (r) C({ ...cf, token: "" });
            }}
          >
            <h2>Cloudflare Tunnel + Access</h2>
            <Input
              label="API Token"
              type="password"
              autoComplete="off"
              value={cf.token}
              onChange={(e) => C({ ...cf, token: e.target.value })}
            />
            <Input
              label="託管網域"
              placeholder="example.com"
              value={cf.zone}
              onChange={(e) => C({ ...cf, zone: e.target.value })}
              required
            />
            <Input
              label="網域前綴"
              value={cf.prefix}
              onChange={(e) => C({ ...cf, prefix: e.target.value })}
            />
            <Field label="允許登入的完整信箱（每行一個）">
              <textarea
                value={cf.emails}
                rows="4"
                onChange={(e) => C({ ...cf, emails: e.target.value })}
                required
              />
            </Field>
            <button
              className="primary"
              disabled={busy || Boolean(state?.cloudflare)}
            >
              檢查並分配空閒網址
            </button>
          </form>
          <div className="card">
            <h2>遠端入口</h2>
            {state?.cloudflare ? (
              <>
                <a
                  className="endpoint"
                  href={state.cloudflare.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {state.cloudflare.url}
                </a>
                <p>狀態：{state.cloudflare.stage}</p>
                <ul>
                  {state.cloudflare.allowedEmails.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() => run("cloudflare-apply")}
                >
                  套用 Access 並啟動 Tunnel
                </button>
                <button disabled={busy} onClick={() => run("cloudflare-start")}>
                  重接 Tunnel
                </button>
              </>
            ) : (
              <p>填入設定後，這裡會先顯示分配的網址與登入名單。</p>
            )}
            <button onClick={() => T("guide")}>查看 Token 權限與指引</button>
          </div>
        </div>
      )}
      {tab === "model" && (
        <form
          className="card narrow"
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await run("model", model);
            if (r) M({ ...model, apiKey: "" });
          }}
        >
          <h2>Claude API</h2>
          <Input
            label="Anthropic API Key"
            type="password"
            value={model.apiKey}
            onChange={(e) => M({ ...model, apiKey: e.target.value })}
            placeholder={
              state?.apiKeyConfigured ? "已儲存；留空保留" : "sk-ant-…"
            }
          />
          <Input
            label="新會話預設模型"
            value={model.model}
            onChange={(e) => M({ ...model, model: e.target.value })}
          />
          <button className="primary" disabled={busy}>
            儲存
          </button>
        </form>
      )}
      {tab === "keys" && (
        <div className="settings-grid">
          <div className="card">
            <h2>匹配已有私鑰</h2>
            <Field label="已有的公鑰（選填，用於匹配）">
              <textarea
                rows="3"
                value={pub}
                onChange={(e) => P(e.target.value)}
                placeholder="ssh-ed25519 …"
              />
            </Field>
            <Input
              label="搜尋目錄（留空使用目前使用者 .ssh）"
              value={dir}
              onChange={(e) => D(e.target.value)}
            />
            <button
              className="primary"
              disabled={busy}
              onClick={async () => {
                const r = await run("key-scan", {
                  directory: dir,
                  publicKey: pub,
                });
                if (r) K(r.keys);
              }}
            >
              查找匹配私鑰
            </button>
            <button
              disabled={busy || !dir || !pub}
              onClick={async () => {
                const r = await run("key-scan-admin", {
                  directory: dir,
                  publicKey: pub,
                });
                if (r) K(r.keys);
              }}
            >
              系統授權後查找指定目錄
            </button>
            {keys.map((k, i) => (
              <div className="key-row" key={k.keyId || i}>
                <b>{k.name}</b>
                <code>{k.fingerprint || "已加密；尚未驗證匹配"}</code>
                {k.keyId && (
                  <button
                    onClick={() => {
                      update("keyId", k.keyId);
                      T("servers");
                    }}
                  >
                    用於新增伺服器
                  </button>
                )}
              </div>
            ))}
          </div>
          <div className="card">
            <h2>建立新金鑰</h2>
            <p>私鑰留在本機，只把公鑰加入伺服器的 authorized_keys。</p>
            <pre>ssh-keygen -t ed25519 -C "starport"</pre>
            <p>
              依提示選擇儲存位置與密語。副檔名 .pub 的檔案是公鑰；同名且沒有
              .pub 的檔案是私鑰。
            </p>
            <button
              disabled={busy}
              onClick={async () => {
                const r = await run("key-generate");
                if (r) {
                  K([r]);
                  P(r.publicKey);
                }
              }}
            >
              在私有目錄產生部署專用金鑰
            </button>
            <small>
              此按鈕產生無密語金鑰，依作業系統檔案權限保護。需要密語時使用上面的指令與
              ssh-agent。
            </small>
            {pub && <pre>{pub}</pre>}
          </div>
        </div>
      )}
      {tab === "guide" && (
        <article className="card guide">
          <h2>從一台新電腦開始</h2>
          <ol>
            <li>執行安裝器並啟動面板，使用終端中的存取碼登入。</li>
            <li>
              匯入訂閱，選擇節點，按「套用並啟動」。Mihomo 會自動下載並校驗。
            </li>
            <li>
              新增伺服器：貼上 SSH 指令與私鑰，或填 DSW 實例及 ProxyClient
              憑證。VPC 指令需要本機已能連入該 VPC。
            </li>
            <li>
              核對主機指紋，按「初始化環境」。系統下載已校驗的 rootfs 與
              gVisor，建立出口並執行隔離自測。
            </li>
            <li>填入 Claude API Key，建立會話。</li>
            <li>
              如需手機遠端操作，填 Cloudflare
              Token、網域及信箱名單，先檢查網址，再套用並登入新網址。
            </li>
          </ol>
          <h3>Cloudflare Token 權限</h3>
          <p>
            帳戶：Cloudflare Tunnel Edit、Access: Apps and Policies
            Edit、Access: Organizations, Identity Providers, and Groups
            Read。網域：Zone Read、DNS Edit。僅授予目標帳戶與網域；Zero Trust
            需先啟用電子郵件一次性 PIN 或其他登入方式。
          </p>
          <h3>每個人各自一套</h3>
          <p>
            不同使用者使用不同
            STARPORT_PI_STATE、面板連接埠與遠端工作帳戶／實例；登入信箱只加入各自的
            Access 名單。管理入口另需本機存取碼。
          </p>
          <h3>SSH 金鑰</h3>
          <pre>
            {
              'ssh-keygen -t ed25519 -C "starport"\nssh-keygen -y -f path/to/private_key\nssh-keygen -lf path/to/public_key.pub'
            }
          </pre>
          <p>
            第二行從已有私鑰取出公鑰；無法從公鑰還原遺失的私鑰。不要把私鑰傳給其他人。加密私鑰需要先加入作業系統
            ssh-agent。
          </p>
        </article>
      )}
      {busy && (
        <div role="status" className="status-line">
          <i className="spinner" />
          正在處理…
        </div>
      )}
      {result?.url && (
        <div className="card">
          <a href={result.url} target="_blank" rel="noreferrer">
            開啟 {result.url}
          </a>
        </div>
      )}
      {state?.operations.length > 0 && (
        <section className="card operations">
          <h2>部署進度</h2>
          {state.operations.slice(0, 4).map((op) => (
            <div key={op.id} className="list-row">
              <div>
                <b>{op.kind}</b>
                <small>
                  {op.stage}
                  {op.detail?.bytes !== undefined
                    ? ` · ${(op.detail.bytes / 1048576).toFixed(1)} MiB${op.detail.total ? " / " + (op.detail.total / 1048576).toFixed(1) + " MiB" : ""}`
                    : ""}
                  {op.error ? " · " + op.error : ""}
                </small>
              </div>
              <span className={"badge " + op.status}>
                {op.status === "complete"
                  ? "完成"
                  : op.status === "failed"
                    ? "失敗"
                    : op.status === "interrupted"
                      ? "待核對"
                      : "進行中"}
              </span>
            </div>
          ))}
        </section>
      )}
    </section>
  );
}
