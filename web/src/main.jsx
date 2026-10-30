import React, { useState, useEffect, useRef, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import Markdown from "react-markdown";
import { createSHA256 } from "hash-wasm";
import { api, setCsrf, fileUrl } from "./api";
import "./style.css";
const Setup = lazy(() => import("./Setup"));
const bytes = (n) =>
  n < 1024
    ? n + " B"
    : n < 1048576
      ? (n / 1024).toFixed(1) + " KiB"
      : (n / 1048576).toFixed(1) + " MiB";
const label = (s) =>
  ({
    idle: "已就緒",
    thinking: "思考中",
    tool: "執行工具",
    error: "需要處理",
    interrupted: "已中斷",
    running: "執行中",
    completed: "已完成",
    succeeded: "已完成",
    failed: "失敗",
    cancelled: "已取消",
    queued: "等待中",
  })[s] || s;
function Icon({ name }) {
  const paths = {
    chat: "M4 4h16v12H8l-4 4V4z",
    folder: "M3 6h6l2 2h10v12H3V6z",
    send: "m3 3 18 9-18 9 4-9-4-9m4 9h14",
    file: "M6 3h8l4 4v14H6V3zm8 0v5h4",
    menu: "M4 6h16M4 12h16M4 18h16",
    settings: "M4 7h16M4 17h16M8 4v6M16 14v6",
    plus: "M12 4v16M4 12h16",
    clip: "m9 14 6-6a3 3 0 0 1 4 4l-9 9a5 5 0 0 1-7-7l10-10a2 2 0 0 1 3 3L6 17",
  };
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name] || paths.file} />
    </svg>
  );
}
function Login({ onLogin }) {
  const [key, K] = useState(""),
    [error, E] = useState("");
  return (
    <main className="login">
      <div className="star-mark">✦</div>
      <h1>Starport Pi</h1>
      <p>你的遠端工作台</p>
      <form
        className="card"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api("login", { key });
            K("");
            onLogin();
          } catch (e) {
            E(e.message);
          }
        }}
      >
        <label className="field">
          本機存取碼
          <input
            autoFocus
            type="password"
            autoComplete="off"
            value={key}
            onChange={(e) => K(e.target.value)}
            required
          />
        </label>
        <button className="primary">進入工作台</button>
        {error && <p className="error">{error}</p>}
        <small>
          使用啟動視窗中的存取碼。遠端網址請透過 Cloudflare Access 登入。
        </small>
      </form>
    </main>
  );
}
const mdComponents = {
  img: ({ src, alt }) => (
    <span className="muted">[圖片：{alt || "attachment"}]</span>
  ),
  a: ({ href, children }) =>
    /^https?:\/\//.test(href || "") ? (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
};
function Message({ row }) {
  const tool = row.role === "toolResult";
  return (
    <article className={"message " + (row.role === "user" ? "user" : "")}>
      <div className="avatar">
        {row.role === "user" ? "你" : tool ? "›" : "✦"}
      </div>
      <div className="message-body">
        <div className="message-heading">
          <b>
            {row.role === "user" ? "你" : tool ? row.toolName : "Starport Pi"}
          </b>
          {row.timestamp && (
            <time>
              {new Date(row.timestamp).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </time>
          )}
        </div>
        {tool ? (
          <details className="tool">
            <summary>
              {row.isError ? "工具未完成" : "工具結果"}
              <span className="badge">{row.toolName}</span>
            </summary>
            <pre>
              {row.content
                .filter((c) => c.type === "text")
                .map((c) => c.text)
                .join("\n")}
            </pre>
          </details>
        ) : (
          row.content.map((c, i) =>
            c.type === "text" ? (
              <div className="markdown" key={i}>
                <Markdown components={mdComponents}>{c.text}</Markdown>
              </div>
            ) : c.type === "thinking" ? (
              <details className="thinking" key={i}>
                <summary>思考過程</summary>
                <Markdown>{c.thinking}</Markdown>
              </details>
            ) : c.type === "toolCall" ? (
              <details key={i} className="tool" open={c.name === "bash"}>
                <summary>
                  <Icon name="file" />
                  {c.name === "bash" ? "遠端命令" : c.name}
                </summary>
                <pre>
                  {c.arguments?.command || JSON.stringify(c.arguments, null, 2)}
                </pre>
              </details>
            ) : null,
          )
        )}
      </div>
    </article>
  );
}
function App() {
  const [boot, S] = useState(null),
    [login, L] = useState(false),
    [error, E] = useState(""),
    [active, A] = useState(""),
    [tab, T] = useState("conversation"),
    [showMenu, Menu] = useState(false),
    [showSetup, SetupView] = useState(false),
    [guide, G] = useState(false),
    [newOpen, New] = useState(false),
    [title, Title] = useState(""),
    [server, Server] = useState("");
  const [views, V] = useState({}),
    [message, M] = useState(""),
    [sending, Send] = useState(false),
    [uploading, U] = useState(""),
    [files, F] = useState([]),
    [filePath, Path] = useState("."),
    [job, J] = useState(""),
    [logs, Log] = useState(""),
    [artifacts, Art] = useState([]),
    [now, Now] = useState(Date.now()),
    [model, Model] = useState(""),
    [effort, Effort] = useState("high");
  const cursors = useRef({}),
    viewsRef = useRef({}),
    fileInput = useRef(),
    end = useRef(),
    activeRef = useRef(""),
    requestId = useRef(null),
    logCursor = useRef(0),
    wasLoggedIn = useRef(false);
  const refresh = async () => {
    try {
      const data = await api("bootstrap");
      setCsrf(data.csrf);
      S(data);
      wasLoggedIn.current = true;
      L(false);
      E((e) =>
        ["Failed to fetch", "authentication_required"].includes(e) ? "" : e,
      );
      Server((v) => v || data.servers[0] || "");
    } catch (e) {
      if (e.status === 401 && !wasLoggedIn.current) L(true);
      else E(e.message);
    }
  };
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000),
      clock = setInterval(() => Now(Date.now()), 1000);
    return () => {
      clearInterval(t);
      clearInterval(clock);
    };
  }, []);
  const current =
      views[active]?.session || boot?.sessions.find((s) => s.id === active),
    rows = views[active]?.rows || [];
  useEffect(() => {
    Model(current?.model || "");
    Effort(current?.effort || "high");
  }, [active, current?.model, current?.effort]);
  useEffect(() => {
    activeRef.current = active;
    if (!active) return;
    let stopped = false,
      busy = false;
    const abort = new AbortController();
    const poll = async () => {
      if (busy) return;
      busy = true;
      try {
        const prev = cursors.current[active] || {},
          data = await api(
            "sessions/" +
              active +
              "/messages?" +
              new URLSearchParams({
                cursor: prev.revision || 0,
                epoch: prev.epoch || "",
              }),
            undefined,
            abort.signal,
          );
        if (stopped) return;
        const map = new Map(
          (data.reset ? [] : viewsRef.current[active]?.rows || []).map((m) => [
            m.id,
            m,
          ]),
        );
        data.messages.forEach((m) => map.set(m.id, m));
        const merged = data.ids.map((id) => map.get(id)).filter(Boolean);
        const next = {
          ...viewsRef.current,
          [active]: { rows: merged, session: data.session },
        };
        viewsRef.current = next;
        V(next);
        cursors.current[active] = {
          revision: data.revision,
          epoch: data.epoch,
        };
      } catch (e) {
        if (!stopped) E(e.message);
      } finally {
        busy = false;
      }
    };
    poll();
    const t = setInterval(poll, 1200);
    return () => {
      stopped = true;
      abort.abort();
      clearInterval(t);
    };
  }, [active]);
  useEffect(() => {
    if (tab === "conversation")
      end.current?.scrollIntoView({ block: "nearest" });
  }, [rows.length, active, tab]);
  async function readFiles() {
    if (!active) return;
    try {
      F(
        (
          await api(
            "sessions/" +
              active +
              "/files?" +
              new URLSearchParams({ path: filePath }),
          )
        ).entries,
      );
    } catch (e) {
      E(e.message);
    }
  }
  useEffect(() => {
    if (tab === "files") readFiles();
  }, [active, tab, filePath]);
  useEffect(() => {
    if (!active || !job || tab !== "tasks") return;
    let stop = false;
    const abort = new AbortController();
    Log("");
    logCursor.current = 0;
    const poll = async () => {
      try {
        const d = await api(
          "sessions/" +
            active +
            "/logs?" +
            new URLSearchParams({ job, cursor: logCursor.current }),
          undefined,
          abort.signal,
        );
        if (stop) return;
        logCursor.current = d.cursor;
        Log(
          (s) =>
            (d.truncated ? "[較舊日誌已輪替]\n" : "") +
            (s + d.text).slice(-2 * 1024 * 1024),
        );
      } catch (e) {
        if (!stop) E(e.message);
      }
    };
    poll();
    const t = setInterval(poll, 2000);
    api("sessions/" + active + "/artifacts?job=" + job, undefined, abort.signal)
      .then((d) => {
        if (!stop) Art(d.artifacts);
      })
      .catch(() => {});
    return () => {
      stop = true;
      abort.abort();
      clearInterval(t);
    };
  }, [active, job, tab]);
  const choose = (id) => {
    A(id);
    Menu(false);
    T("conversation");
    Path(".");
    J("");
    E("");
    M("");
    requestId.current = null;
  };
  async function send(e) {
    e.preventDefault();
    if (!message.trim() || !active || sending) return;
    Send(true);
    E("");
    requestId.current ||= crypto.randomUUID();
    try {
      await api("sessions/" + active + "/send", {
        text: message,
        requestId: requestId.current,
      });
      M("");
      requestId.current = null;
      refresh();
    } catch (e) {
      E(e.message);
    } finally {
      Send(false);
    }
  }
  async function upload(file) {
    if (!file) return;
    U("計算校驗值");
    E("");
    try {
      const hash = await createSHA256();
      hash.init();
      for (let offset = 0; offset < file.size; offset += 1048576)
        hash.update(
          new Uint8Array(
            await file.slice(offset, offset + 1048576).arrayBuffer(),
          ),
        );
      const sha256 = hash.digest("hex"),
        resumeKey = "starport-upload-" + active + "-" + sha256;
      // Only an opaque grant and checksum are retained; never credentials or file contents.
      let grant;
      try {
        grant = JSON.parse(sessionStorage.getItem(resumeKey));
      } catch {}
      if (!grant) {
        grant = await api("sessions/" + active + "/upload-begin", {
          name: file.name,
          bytes: file.size,
          sha256,
        });
        sessionStorage.setItem(resumeKey, JSON.stringify(grant));
      }
      const h = await createSHA256();
      while (grant.offset < file.size) {
        const data = new Uint8Array(
          await file.slice(grant.offset, grant.offset + 1048576).arrayBuffer(),
        );
        h.init();
        h.update(data);
        let binary = "";
        for (let i = 0; i < data.length; i += 32768)
          binary += String.fromCharCode(...data.subarray(i, i + 32768));
        const r = await api("sessions/" + active + "/upload-chunk", {
          upload: grant.id,
          offset: grant.offset,
          data: btoa(binary),
          sha256: h.digest("hex"),
        });
        grant.offset = r.offset;
        sessionStorage.setItem(resumeKey, JSON.stringify(grant));
        U(
          "上傳 " +
            Math.round((grant.offset / Math.max(file.size, 1)) * 100) +
            "%",
        );
      }
      const done = await api("sessions/" + active + "/upload-finish", {
        upload: grant.id,
      });
      if (done.sha256 !== sha256) throw new Error("upload_checksum");
      sessionStorage.removeItem(resumeKey);
      M((s) => s + (s ? "\n" : "") + "已附加檔案：/workspace/" + done.path);
      readFiles();
    } catch (e) {
      E(e.message + " · 重選同一檔案可接續");
    } finally {
      U("");
    }
  }
  if (login) return <Login onLogin={refresh} />;
  if (!boot)
    return (
      <div className="loading">
        <span className="star-mark">✦</span>正在連接 Starport Pi…
        {error && <p>{error}</p>}
      </div>
    );
  const health = boot.health[current?.server || server],
    working = ["thinking", "tool"].includes(current?.status),
    elapsed = current?.startedAt
      ? Math.max(
          0,
          Math.floor(
            ((working ? now : current.finishedAt || now) - current.startedAt) /
              1000,
          ),
        )
      : 0;
  return (
    <div className="app">
      <header className="topbar">
        <button
          className="icon mobile"
          aria-label="開啟會話列表"
          onClick={() => Menu(!showMenu)}
        >
          <Icon name="menu" />
        </button>
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            SetupView(false);
          }}
        >
          <span>✦</span>Starport Pi
        </a>
        <div className="top-actions">
          <span className="connection">
            <i className={"dot " + (health?.ready ? "ok" : "")} />
            {health?.ready ? "已連線" : "待設定"}
          </span>
          <button
            onClick={() => {
              G(true);
              SetupView(true);
            }}
          >
            指引
          </button>
          <button
            className="icon"
            title="部署與管理"
            aria-label="部署與管理"
            onClick={() => {
              G(false);
              SetupView(true);
            }}
          >
            <Icon name="settings" />
          </button>
        </div>
      </header>
      {showSetup ? (
        <Suspense fallback={<p className="loading">正在載入管理介面…</p>}>
          <Setup
            guideOnly={guide}
            onClose={() => {
              SetupView(false);
              refresh();
            }}
            onChange={refresh}
          />
        </Suspense>
      ) : (
        <div className="shell">
          <aside className={"sidebar " + (showMenu ? "visible" : "")}>
            <button className="primary new-session" onClick={() => New(true)}>
              <Icon name="plus" />
              新增會話
            </button>
            <div className="sidebar-label">會話</div>
            <nav>
              {boot.sessions.map((s) => (
                <button
                  className={"session " + (active === s.id ? "active" : "")}
                  key={s.id}
                  onClick={() => choose(s.id)}
                >
                  <Icon name="folder" />
                  <span>
                    {s.title}
                    <small>
                      {["thinking", "tool"].includes(s.status)
                        ? label(s.status)
                        : s.server}
                    </small>
                  </span>
                </button>
              ))}
            </nav>
            <button
              className="sidebar-bottom"
              onClick={() => {
                G(false);
                SetupView(true);
              }}
            >
              <Icon name="settings" />
              部署與管理
            </button>
          </aside>
          <main className="workspace">
            {!current ? (
              <div className="empty">
                <div className="star-mark">✦</div>
                <h1>開始你的下一段探索</h1>
                <p>連接伺服器，建立一個遠端專案。</p>
                <button
                  className="primary"
                  onClick={() =>
                    boot.servers.length
                      ? New(true)
                      : (G(false), SetupView(true))
                  }
                >
                  {boot.servers.length ? "新增會話" : "開啟部署向導"}
                </button>
              </div>
            ) : (
              <>
                <div className="view-heading">
                  <div>
                    <h1>{current.title}</h1>
                    <p>{current.server} · 遠端工作區</p>
                  </div>
                  <div className="live-state" role="status">
                    <i
                      className={
                        working
                          ? "spinner"
                          : "dot " +
                            (current.status === "error" ? "error-dot" : "ok")
                      }
                    />
                    {current.tool || label(current.status)}
                    {current.startedAt && (
                      <span>
                        {Math.floor(elapsed / 60)}:
                        {String(elapsed % 60).padStart(2, "0")}
                      </span>
                    )}
                  </div>
                </div>
                <nav className="tabs" aria-label="工作區">
                  <button
                    className={tab === "conversation" ? "active" : ""}
                    onClick={() => T("conversation")}
                  >
                    對話
                  </button>
                  <button
                    className={tab === "tasks" ? "active" : ""}
                    onClick={() => {
                      T("tasks");
                      J((j) => j || current.jobs.at(-1)?.id || "");
                    }}
                  >
                    任務 <span>{current.jobs.length}</span>
                  </button>
                  <button
                    className={tab === "files" ? "active" : ""}
                    onClick={() => T("files")}
                  >
                    檔案
                  </button>
                </nav>
                {(error || current.error) && (
                  <div role="alert" className="error">
                    {error || current.error}
                  </div>
                )}
                {tab === "conversation" && (
                  <>
                    <form
                      className="modelbar"
                      onSubmit={async (e) => {
                        e.preventDefault();
                        try {
                          await api("sessions/" + active + "/settings", {
                            model,
                            effort,
                          });
                          refresh();
                        } catch (e) {
                          E(e.message);
                        }
                      }}
                    >
                      <label>
                        模型
                        <input
                          aria-label="模型"
                          value={model}
                          onChange={(e) => Model(e.target.value)}
                          disabled={working}
                        />
                      </label>
                      <label>
                        Effort
                        <select
                          value={effort}
                          onChange={(e) => Effort(e.target.value)}
                          disabled={working}
                        >
                          {[
                            "off",
                            "minimal",
                            "low",
                            "medium",
                            "high",
                            "xhigh",
                            "max",
                          ].map((x) => (
                            <option key={x}>{x}</option>
                          ))}
                        </select>
                      </label>
                      <button disabled={working}>套用</button>
                    </form>
                    <div className="messages">
                      {rows.map((row) => (
                        <Message key={row.id} row={row} />
                      ))}
                      {!rows.length && (
                        <p className="muted empty-message">
                          說明目標，或附加專案檔案開始。
                        </p>
                      )}
                      <div ref={end} />
                    </div>
                    <form className="composer" onSubmit={send}>
                      <input
                        hidden
                        ref={fileInput}
                        type="file"
                        onChange={(e) => {
                          upload(e.target.files[0]);
                          e.target.value = "";
                        }}
                      />
                      <button
                        type="button"
                        className="attach"
                        disabled={Boolean(uploading)}
                        onClick={() => fileInput.current.click()}
                      >
                        <Icon name="clip" />
                        <span>附加</span>
                      </button>
                      <textarea
                        aria-label="訊息"
                        placeholder="傳送訊息…"
                        value={message}
                        onChange={(e) => {
                          M(e.target.value);
                          requestId.current = null;
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                            e.preventDefault();
                            send(e);
                          }
                        }}
                        rows="2"
                      />
                      {working ? (
                        <button
                          type="button"
                          onClick={() =>
                            api("sessions/" + active + "/stop", {}).catch((e) =>
                              E(e.message),
                            )
                          }
                        >
                          停止回覆
                        </button>
                      ) : (
                        <button
                          className="primary"
                          disabled={
                            sending || !message.trim() || Boolean(uploading)
                          }
                        >
                          <Icon name="send" />
                          <span>傳送</span>
                        </button>
                      )}
                      {uploading && (
                        <small className="upload-progress" role="status">
                          {uploading}
                        </small>
                      )}
                    </form>
                  </>
                )}
                {tab === "tasks" && (
                  <section className="task-view">
                    <div className="task-list">
                      {current.jobs.map((j) => (
                        <button
                          key={j.id}
                          className={
                            "task-row " + (job === j.id ? "selected" : "")
                          }
                          onClick={() => {
                            J(j.id);
                            Art([]);
                          }}
                        >
                          <span>{j.id.slice(0, 8)}</span>
                          <span className="badge">
                            {label(j.status || "queued")}
                          </span>
                          <small>
                            {j.released ? "資源已釋放" : "資源待確認"}
                          </small>
                        </button>
                      ))}
                    </div>
                    {job ? (
                      <>
                        <div className="task-toolbar">
                          <b>即時日誌</b>
                          <a
                            href={
                              "data:text/plain;charset=utf-8," +
                              encodeURIComponent(logs)
                            }
                            download={"logs-" + job.slice(0, 8) + ".txt"}
                          >
                            下載已載入日誌
                          </a>
                          {!current.jobs.find((j) => j.id === job)
                            ?.released && (
                            <button
                              onClick={async () => {
                                try {
                                  await api(
                                    "sessions/" + active + "/cancel?job=" + job,
                                    {},
                                  );
                                  refresh();
                                } catch (e) {
                                  E(e.message);
                                }
                              }}
                            >
                              取消此任務
                            </button>
                          )}
                        </div>
                        <pre className="logs">{logs || "等待日誌…"}</pre>
                        <div className="artifact-list">
                          <h3>產物</h3>
                          <button
                            onClick={() =>
                              api(
                                "sessions/" + active + "/artifacts?job=" + job,
                              )
                                .then((d) => Art(d.artifacts))
                                .catch((e) => E(e.message))
                            }
                          >
                            更新產物
                          </button>
                          {artifacts.map((f) => (
                            <a
                              key={f.path}
                              className="list-row"
                              href={fileUrl(active, f.path, job)}
                              download
                            >
                              <span>{f.path}</span>
                              <small>{bytes(f.bytes)} ↓</small>
                            </a>
                          ))}
                        </div>
                      </>
                    ) : (
                      <p className="muted">
                        還沒有任務。可在對話中要求執行驗證或訓練。
                      </p>
                    )}
                  </section>
                )}
                {tab === "files" && (
                  <section className="files">
                    <div className="task-toolbar">
                      <b>/workspace/{filePath === "." ? "" : filePath}</b>
                      <button
                        onClick={() => {
                          Path(".");
                          readFiles();
                        }}
                      >
                        根目錄
                      </button>
                      <button onClick={() => fileInput.current.click()}>
                        上傳
                      </button>
                      <input
                        type="file"
                        hidden
                        ref={fileInput}
                        onChange={(e) => {
                          upload(e.target.files[0]);
                          e.target.value = "";
                        }}
                      />
                    </div>
                    {uploading && <p role="status">{uploading}</p>}
                    {files.map((f) => (
                      <div className="list-row" key={f.name}>
                        <span>
                          <Icon
                            name={f.kind === "directory" ? "folder" : "file"}
                          />
                          {f.kind === "directory" ? (
                            <button
                              onClick={() =>
                                Path(
                                  (filePath === "." ? "" : filePath + "/") +
                                    f.name,
                                )
                              }
                            >
                              {f.name}/
                            </button>
                          ) : (
                            f.name
                          )}
                        </span>
                        <span>
                          {bytes(f.bytes)}{" "}
                          {f.kind === "file" && (
                            <a
                              href={fileUrl(
                                active,
                                (filePath === "." ? "" : filePath + "/") +
                                  f.name,
                              )}
                              download
                            >
                              下載 ↓
                            </a>
                          )}
                        </span>
                      </div>
                    ))}
                    {!files.length && <p className="muted">工作區尚無檔案。</p>}
                  </section>
                )}
              </>
            )}
          </main>
          <aside className="activity">
            <h2>任務動態</h2>
            {current?.jobs
              .slice(-4)
              .reverse()
              .map((j) => (
                <button
                  className="activity-item"
                  key={j.id}
                  onClick={() => {
                    J(j.id);
                    T("tasks");
                  }}
                >
                  <Icon name="file" />
                  <span>
                    {j.id.slice(0, 8)}
                    <small>{label(j.status || "queued")}</small>
                  </span>
                </button>
              ))}
            {!current?.jobs.length && (
              <p className="muted">新的執行紀錄會顯示於此。</p>
            )}
            <div className="resource">
              <h3>{current?.server || "伺服器"}</h3>
              {health?.ready ? (
                <>
                  <p>
                    {health.cpus} CPU · {health.memoryGiB} GiB
                  </p>
                  <p>
                    {health.gpus} GPU{" "}
                    <span className="badge">
                      {health.networkReady ? "出口已連接" : "出口離線"}
                    </span>
                  </p>
                </>
              ) : (
                <p>尚未連接</p>
              )}
            </div>
          </aside>
        </div>
      )}
      {newOpen && (
        <div className="modal-backdrop">
          <form
            className="card modal"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                const s = await api("sessions", { title, server });
                await refresh();
                choose(s.id);
                Title("");
                New(false);
              } catch (e) {
                E(e.message);
              }
            }}
          >
            <h2>新增會話</h2>
            <label className="field">
              專案名稱
              <input
                autoFocus
                value={title}
                onChange={(e) => Title(e.target.value)}
                required
                maxLength="100"
              />
            </label>
            <label className="field">
              伺服器
              <select
                value={server}
                onChange={(e) => Server(e.target.value)}
                required
              >
                <option value="">選擇已初始化的伺服器</option>
                {boot.servers.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
            {error && <p className="error">{error}</p>}
            <div className="form-row">
              <button type="button" onClick={() => New(false)}>
                取消
              </button>
              <button className="primary" disabled={!server}>
                建立
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")).render(<App />);
