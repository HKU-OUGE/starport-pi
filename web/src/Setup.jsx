import React, { useEffect, useState, useRef } from "react";
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
  const loaded = useRef({});
  const [exportPassword, ExportPassword] = useState("");
  const [transfer, Transfer] = useState({
    password: "",
    bundle: null,
    name: "",
    preview: null,
    activateNetwork: true,
  });
  const [local, Local] = useState({ cpus: 4, memoryGiB: 4 });
  const refresh = () =>
    setup("state")
      .then((s) => {
        S(s);
        if (loaded.current.model !== s.model) {
          loaded.current.model = s.model;
          M((m) => ({ ...m, model: s.model || m.model }));
        }
        const draft = JSON.stringify(s.cloudflareDraft);
        if (loaded.current.draft !== draft) {
          loaded.current.draft = draft;
          if (s.cloudflareDraft)
            C((c) => ({
              ...c,
              zone: s.cloudflareDraft.zone,
              prefix: s.cloudflareDraft.prefix,
              emails: s.cloudflareDraft.allowedEmails.join("\n"),
            }));
        }
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
          <h1>部署与管理</h1>
        </div>
        <button onClick={onClose}>返回工作台</button>
      </div>
      <nav className="tabs" aria-label="管理分类">
        {[
          ["network", "01 订阅与出口"],
          ["servers", "02 服务器"],
          ["access", "03 远端入口"],
          ["model", "模型"],
          ["local", "本机隔离"],
          ["transfer", "导入与导出"],
          ["keys", "SSH 密钥"],
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
          <h2>解锁管理功能</h2>
          <Input
            label="本机启动窗口中的管理访问码"
            type="password"
            value={admin}
            onChange={(e) => A(e.target.value)}
          />
          <button className="primary">解锁</button>
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
            <h2>导入订阅</h2>
            <Input
              label="名称"
              value={sub.label}
              onChange={(e) => Sub({ ...sub, label: e.target.value })}
            />
            <Input
              label="HTTPS 订阅网址"
              type="password"
              autoComplete="off"
              value={sub.url}
              onChange={(e) => Sub({ ...sub, url: e.target.value })}
            />
            <details>
              <summary>或贴上 YAML／节点清单</summary>
              <textarea
                rows="5"
                aria-label="订阅内容"
                value={sub.text}
                onChange={(e) => Sub({ ...sub, text: e.target.value })}
              />
            </details>
            <button className="primary" disabled={disabled}>
              导入节点
            </button>
          </form>
          <div className="card">
            <h2>选择出口</h2>
            <Field label="节点">
              <select value={node} onChange={(e) => N(e.target.value)}>
                <option value="">选择节点</option>
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
              应用并启动
            </button>
            <div className="status-line">
              <i className={"dot " + (state?.proxy?.running ? "ok" : "")} />
              {state?.proxy?.running ? "代理已运作" : "尚未启动"}
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
            <h2>新增服务器</h2>
            <Input
              label="公开别名"
              value={server.name}
              onChange={(e) => update("name", e.target.value)}
              required
            />
            <Field label="连接方式">
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
                  label="实例 ID"
                  value={server.instanceId}
                  onChange={(e) => update("instanceId", e.target.value)}
                  required
                />
                <Input
                  label="实际区域 ID"
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
                  label="STS Token（选填）"
                  type="password"
                  value={server.stsToken}
                  onChange={(e) => update("stsToken", e.target.value)}
                />
              </>
            )}
            {server.keyId ? (
              <p className="success">
                已选择本机匹配密钥{" "}
                <button type="button" onClick={() => update("keyId", null)}>
                  更换
                </button>
              </p>
            ) : (
              <>
                <Field label="SSH 私钥">
                  <textarea
                    rows="3"
                    autoComplete="off"
                    spellCheck="false"
                    value={server.privateKey}
                    onChange={(e) => update("privateKey", e.target.value)}
                    placeholder="贴上私钥，或选取文件"
                  />
                </Field>
                <input
                  type="file"
                  aria-label="选取私钥文件"
                  onChange={async (e) => {
                    if (e.target.files[0])
                      update("privateKey", await e.target.files[0].text());
                    e.target.value = "";
                  }}
                />
                <button type="button" onClick={() => T("keys")}>
                  查找匹配的私钥
                </button>
              </>
            )}
            <div className="form-row">
              <Input
                label="CPU 核心预算"
                type="number"
                min="1"
                max="512"
                value={server.cpus}
                onChange={(e) => update("cpus", Number(e.target.value))}
              />
              <Input
                label="内存 GiB"
                type="number"
                min="2"
                value={server.memoryGiB}
                onChange={(e) => update("memoryGiB", Number(e.target.value))}
              />
            </div>
            <Input
              label="专用 GPU 编号（逗号分隔；留空为 CPU）"
              value={server.gpuText}
              onChange={(e) => update("gpuText", e.target.value)}
            />
            <button className="primary" disabled={disabled}>
              新增并测试连接
            </button>
          </form>
          <div className="card">
            <h2>服务器初始化</h2>
            {state?.servers
              .filter((s) => s.mode !== "wsl")
              .map((s) => (
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
                    {s.initialized ? "已启用" : "待初始化"}
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
                    重新测试连接
                  </button>
                  {lastScan && (
                    <div className="verification">
                      <h3>核对 SSH 主机指纹</h3>
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
                        指纹正确，初始化环境
                      </button>
                    </div>
                  )}
                </>
              )}
            <p>
              初始化包含执行环境、出口通道与隔离自测。验证通过后才可建立会话。
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
              label="托管域名"
              placeholder="example.com"
              value={cf.zone}
              onChange={(e) => C({ ...cf, zone: e.target.value })}
              required
            />
            <Input
              label="域名前缀"
              value={cf.prefix}
              onChange={(e) => C({ ...cf, prefix: e.target.value })}
            />
            <Field label="允许登录的完整邮箱（每行一个）">
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
              检查并分配空闲网址
            </button>
          </form>
          <div className="card">
            <h2>远端入口</h2>
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
                <p>状态：{state.cloudflare.stage}</p>
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
                  应用 Access 并启动 Tunnel
                </button>
                <button disabled={busy} onClick={() => run("cloudflare-start")}>
                  重接 Tunnel
                </button>
              </>
            ) : (
              <p>填入设置后，这里会先显示分配的网址与登录名单。</p>
            )}
            <button onClick={() => T("guide")}>查看 Token 权限与指引</button>
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
              state?.apiKeyConfigured ? "已保存；留空保留" : "sk-ant-…"
            }
          />
          <Field label="新会话默认模型">
            <select
              value={model.model}
              onChange={(e) => M({ ...model, model: e.target.value })}
            >
              {(state?.models || []).map((m) => (
                <option value={m.id} key={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </Field>
          <button className="primary" disabled={busy}>
            保存
          </button>
        </form>
      )}
      {tab === "local" && (
        <div className="settings-grid">
          <form
            className="card"
            onSubmit={async (e) => {
              e.preventDefault();
              await run("local-initialize", local);
            }}
          >
            <h2>本机隔离项目</h2>
            <p>Windows 原生面板 · 专用 WSL2 · gVisor</p>
            <Input
              label="CPU 核数"
              type="number"
              min="1"
              max="64"
              value={local.cpus}
              onChange={(e) =>
                Local({ ...local, cpus: Number(e.target.value) })
              }
            />
            <Input
              label="内存（GiB）"
              type="number"
              min="2"
              max="256"
              value={local.memoryGiB}
              onChange={(e) =>
                Local({ ...local, memoryGiB: Number(e.target.value) })
              }
            />
            <button
              className="primary"
              disabled={disabled || state?.platform !== "win32"}
            >
              初始化并验证本机环境
            </button>
            {state?.platform !== "win32" && (
              <p>此入口适用于 Windows x64；当前系统可使用纯聊天或远端项目。</p>
            )}
          </form>
          <div className="card">
            <h2>项目边界</h2>
            <p>
              每个会话有独立项目目录。固定环境变量，禁止直接联网，仅通过选定出口。Windows
              磁盘和凭证不挂入项目。
            </p>
            <p>首次初始化需要已启用 WSL2。准备命令：</p>
            <pre>wsl --install --no-distribution</pre>
            <p>
              在管理员 PowerShell
              执行，按系统提示完成重启。初始化通过实际隔离自测后，才会出现“本机隔离项目”选项。目前提供
              CPU 执行。
            </p>
            {state?.servers
              .filter((s) => s.mode === "wsl")
              .map((s) => (
                <p key={s.name}>
                  {s.name} · {s.initialized ? "验证通过" : "待验证"}
                </p>
              ))}
          </div>
        </div>
      )}
      {tab === "transfer" && (
        <div className="settings-grid">
          <form
            className="card"
            onSubmit={async (e) => {
              e.preventDefault();
              const r = await run("config-export", {
                password: exportPassword,
              });
              if (r?.bundle) {
                const url = URL.createObjectURL(
                  new Blob([JSON.stringify(r.bundle, null, 2)], {
                    type: "application/json",
                  }),
                );
                const a = document.createElement("a");
                a.href = url;
                a.download = "starport-profile.encrypted.json";
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
                ExportPassword("");
                R({ exported: true });
              }
            }}
          >
            <h2>导出配置</h2>
            <p>加密保存模型、订阅、服务器连接和远端入口设置。</p>
            <Input
              label="加密密码（至少 12 个字符）"
              type="password"
              autoComplete="new-password"
              minLength="12"
              value={exportPassword}
              onChange={(e) => ExportPassword(e.target.value)}
              required
            />
            <button className="primary" disabled={disabled}>
              下载加密配置
            </button>
            {result?.exported && <p role="status">已生成加密下载文件。</p>}
          </form>
          <form
            className="card"
            onSubmit={async (e) => {
              e.preventDefault();
              const r = await run("config-import", {
                bundle: transfer.bundle,
                password: transfer.password,
                activateNetwork: transfer.activateNetwork,
              });
              if (r)
                Transfer({
                  ...transfer,
                  password: "",
                  bundle: null,
                  preview: null,
                  name: "",
                });
            }}
          >
            <h2>导入配置</h2>
            <p>
              用于新安装。现有配置不会被覆盖；导入后检查服务器，远端网址另行启用。
            </p>
            <Input
              label="配置文件"
              type="file"
              accept=".json"
              onChange={async (e) => {
                const file = e.target.files[0];
                if (!file) return;
                try {
                  if (file.size > 24 * 1024 * 1024)
                    throw new Error("profile_too_large");
                  const bundle = JSON.parse(await file.text());
                  Transfer((t) => ({
                    ...t,
                    name: file.name,
                    bundle,
                    preview: null,
                  }));
                } catch (err) {
                  E(err.message);
                }
              }}
            />
            <Input
              label="解密密码"
              type="password"
              autoComplete="off"
              value={transfer.password}
              onChange={(e) =>
                Transfer({
                  ...transfer,
                  password: e.target.value,
                  preview: null,
                })
              }
            />
            <button
              type="button"
              disabled={disabled || !transfer.bundle}
              onClick={async () => {
                const r = await run("config-preview", {
                  bundle: transfer.bundle,
                  password: transfer.password,
                });
                if (r) Transfer({ ...transfer, preview: r });
              }}
            >
              检查配置
            </button>
            {transfer.preview && (
              <div className="verification">
                <p>
                  {transfer.preview.model} · {transfer.preview.servers.length}{" "}
                  个服务器 · {transfer.preview.subscriptions} 个订阅
                </p>
                <p>
                  API Key：
                  {transfer.preview.apiKeyIncluded ? "已包含" : "待填写"} ·
                  Cloudflare Token：
                  {transfer.preview.cloudflareTokenIncluded
                    ? "已包含"
                    : "待填写"}
                </p>
                <label>
                  <input
                    type="checkbox"
                    checked={transfer.activateNetwork}
                    onChange={(e) =>
                      Transfer({
                        ...transfer,
                        activateNetwork: e.target.checked,
                      })
                    }
                  />
                  导入后应用选定出口
                </label>
                <button className="primary" disabled={disabled}>
                  导入到当前新配置
                </button>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={async () => {
                    const r = await run("config-update-connections", {
                      bundle: transfer.bundle,
                      password: transfer.password,
                    });
                    if (r)
                      Transfer({
                        ...transfer,
                        password: "",
                        bundle: null,
                        preview: null,
                        name: "",
                      });
                  }}
                >
                  更新已导入的未初始化 DSW 连接
                </button>
                <p>
                  此更新只修正实例 ID
                  和区域，保留现有凭证、订阅、模型和远端入口。已初始化或已有会话的连接不会被修改。
                </p>
              </div>
            )}
          </form>
        </div>
      )}
      {tab === "keys" && (
        <div className="settings-grid">
          <div className="card">
            <h2>匹配已有私钥</h2>
            <Field label="已有的公钥（选填，用于匹配）">
              <textarea
                rows="3"
                value={pub}
                onChange={(e) => P(e.target.value)}
                placeholder="ssh-ed25519 …"
              />
            </Field>
            <Input
              label="搜寻目录（留空使用目前使用者 .ssh）"
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
              查找匹配私钥
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
              系统授权后查找指定目录
            </button>
            {keys.map((k, i) => (
              <div className="key-row" key={k.keyId || i}>
                <b>{k.name}</b>
                <code>{k.fingerprint || "已加密；尚未验证匹配"}</code>
                {k.keyId && (
                  <button
                    onClick={() => {
                      update("keyId", k.keyId);
                      T("servers");
                    }}
                  >
                    用于新增服务器
                  </button>
                )}
              </div>
            ))}
          </div>
          <div className="card">
            <h2>建立新密钥</h2>
            <p>私钥留在本机，只把公钥加入服务器的 authorized_keys。</p>
            <pre>ssh-keygen -t ed25519 -C "starport"</pre>
            <p>
              依提示选择保存位置与密语。副档名 .pub 的文件是公钥；同名且没有
              .pub 的文件是私钥。
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
              在私有目录产生部署专用密钥
            </button>
            <small>
              此按钮产生无密语密钥，依操作系统文件权限保护。需要密语时使用上面的指令与
              ssh-agent。
            </small>
            {pub && <pre>{pub}</pre>}
          </div>
        </div>
      )}
      {tab === "guide" && (
        <article className="card guide">
          <h2>从一台新电脑开始</h2>
          <ol>
            <li>执行安装器并启动面板，使用终端中的访问码登录。</li>
            <li>
              导入订阅，选择节点，按「应用并启动」。Mihomo 会自动下载并校验。
            </li>
            <li>
              新增服务器：贴上 SSH 指令与私钥，或填 DSW 实例及 ProxyClient
              凭证。VPC 指令需要本机已能连入该 VPC。
            </li>
            <li>
              核对主机指纹，按「初始化环境」。系统下载已校验的 rootfs 与
              gVisor，建立出口并执行隔离自测。
            </li>
            <li>
              填入 Claude API
              Key，从列表选择模型。可直接创建纯聊天，或选择通过验证的本机／远端项目。
            </li>
            <li>
              已有加密配置时，在“导入与导出”中导入并应用出口，再核验服务器连接。
            </li>
            <li>
              如需手机远端操作，填 Cloudflare
              Token、域名及邮箱名单，先检查网址，再应用并登录新网址。
            </li>
          </ol>
          <h3>Cloudflare Token 权限</h3>
          <p>
            帐户：Cloudflare Tunnel Edit、Access: Apps and Policies
            Edit、Access: Organizations, Identity Providers, and Groups
            Read。域名：Zone Read、DNS Edit。仅授予目标帐户与域名；Zero Trust
            需先启用电子邮件一次性 PIN 或其他登录方式。
          </p>
          <h3>每个人各自一套</h3>
          <p>
            不同使用者使用不同
            STARPORT_PI_STATE、面板连接埠与远端工作帐户／实例；登录邮箱只加入各自的
            Access 名单。管理入口另需本机访问码。
          </p>
          <h3>SSH 权限边界</h3>
          <p>
            当前连接保存的是操作端管理凭证。Pi 任务通过隔离 worker
            执行，但持有同一 SSH 私钥的人仍可使用其他 SSH
            客户端访问该账户允许的文件。向普通使用者提供服务时，需要另设受限账户或服务器强制命令。
          </p>
          <h3>SSH 密钥</h3>
          <pre>
            {
              'ssh-keygen -t ed25519 -C "starport"\nssh-keygen -y -f path/to/private_key\nssh-keygen -lf path/to/public_key.pub'
            }
          </pre>
          <p>
            第二行从已有私钥取出公钥；无法从公钥还原遗失的私钥。不要把私钥传给其他人。加密私钥需要先加入操作系统
            ssh-agent。
          </p>
        </article>
      )}
      {busy && (
        <div role="status" className="status-line">
          <i className="spinner" />
          正在处理…
        </div>
      )}
      {result?.saved && <p role="status">已保存。</p>}
      {result?.url && (
        <div className="card">
          <a href={result.url} target="_blank" rel="noreferrer">
            开启 {result.url}
          </a>
        </div>
      )}
      {state?.operations.length > 0 && (
        <section className="card operations">
          <h2>部署进度</h2>
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
                  {op.result?.updated?.length
                    ? " · 已更新：" + op.result.updated.join("、")
                    : ""}
                </small>
              </div>
              <span className={"badge " + op.status}>
                {op.status === "complete"
                  ? "完成"
                  : op.status === "failed"
                    ? "失败"
                    : op.status === "interrupted"
                      ? "待核对"
                      : "进行中"}
              </span>
            </div>
          ))}
        </section>
      )}
    </section>
  );
}
