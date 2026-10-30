import React, { useState, useEffect, useRef, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import SessionFeatures from "./SessionFeatures";
import SessionList from "./SessionList";
import SessionManager from "./SessionManager";
import SlashMenu from "./SlashMenu";
import AttachmentCard from "./AttachmentCard";
import PreviewBoundary from "./PreviewBoundary";
const RichMarkdown = lazy(() => import("./RichMarkdown"));
const Usage = lazy(() => import("./Usage"));
import { uploadFile } from "./uploads";
const WorkspaceFiles = lazy(() => import("./WorkspaceFiles"));
import { api, setCsrf, fileUrl } from "./api";
import "./style.css";
const Setup = lazy(() => import("./Setup"));
class SetupBoundary extends React.Component {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <div className="card" role="alert">
        <p>管理界面加载失败，可能已更新版本。</p>
        <button onClick={() => location.reload()}>重新加载界面</button>
      </div>
    ) : (
      this.props.children
    );
  }
}
const label = (s) =>
  ({
    idle: "已就绪",
    thinking: "思考中",
    tool: "执行工具",
    error: "需要处理",
    interrupted: "已中断",
    running: "执行中",
    completed: "已完成",
    succeeded: "已完成",
    failed: "失败",
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
      <p>你的远端工作台</p>
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
          本机访问码
          <input
            autoFocus
            type="password"
            autoComplete="off"
            value={key}
            onChange={(e) => K(e.target.value)}
            required
          />
        </label>
        <button className="primary">进入工作台</button>
        {error && <p className="error">{error}</p>}
        <small>
          使用启动窗口中的访问码。远端网址请透过 Cloudflare Access 登录。
        </small>
      </form>
    </main>
  );
}
function Message({ row, session, attachmentNames }) {
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
              {row.isError ? "工具未完成" : "工具结果"}
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
                <Suspense fallback={<pre>{c.text}</pre>}>
                  <RichMarkdown text={c.text} session={session} />
                </Suspense>
              </div>
            ) : c.type === "thinking" ? (
              <details className="thinking" key={i}>
                <summary>思考过程</summary>
                <Suspense fallback={null}>
                  <RichMarkdown text={c.thinking} session={session} />
                </Suspense>
              </details>
            ) : c.type === "toolCall" ? (
              <details key={i} className="tool" open={c.name === "bash"}>
                <summary>
                  <Icon name="file" />
                  {c.name === "bash" ? "远端命令" : c.name}
                </summary>
                <pre>
                  {c.arguments?.command || JSON.stringify(c.arguments, null, 2)}
                </pre>
              </details>
            ) : null,
          )
        )}
        {row.error && (
          <p role="alert" className="error">
            {row.error}
          </p>
        )}
        {row.native?.paused && (
          <p role="status">已达到自动接续上限。发送“继续”可以接续工具回合。</p>
        )}
        {row.native?.tools?.map((t) => (
          <details className="tool" key={t.id}>
            <summary>
              {t.name}{" "}
              <span className="badge">
                {t.status === "running"
                  ? "执行中"
                  : t.status === "error"
                    ? "未完成"
                    : "已返回"}
              </span>
            </summary>
            <pre>{JSON.stringify(t.input, null, 2)}</pre>
            {t.result && <pre>{JSON.stringify(t.result, null, 2)}</pre>}
          </details>
        ))}
        {row.native?.sources?.length > 0 && (
          <div className="sources">
            {row.native.sources.map((s, i) => (
              <a key={s.url} href={s.url} target="_blank" rel="noreferrer">
                {i + 1}. {s.title}
              </a>
            ))}
          </div>
        )}
        {(row.attachments || []).map((id) => (
          <AttachmentCard
            key={id}
            session={session}
            id={id}
            name={attachmentNames[id] || "附件"}
          />
        ))}
        {(row.native?.files || []).map((id) => (
          <AttachmentCard
            key={id}
            session={session}
            id={id}
            name={"代码执行产物 " + id.slice(-8)}
            cloud
          />
        ))}
        {row.usage?.totalTokens > 0 && (
          <small className="muted">
            {row.usage.input} 输入 · {row.usage.output} 输出 ·{" "}
            {row.usage.cacheRead} 缓存读取
          </small>
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
    [server, Server] = useState("__chat__"),
    [project, Project] = useState(""),
    [manageId, Manage] = useState(""),
    [settingsOpen, SettingsOpen] = useState(false),
    [toolsOpen, ToolsOpen] = useState(false),
    [notice, Notice] = useState("");
  const [views, V] = useState({}),
    [message, M] = useState(""),
    [sending, Send] = useState(false),
    [uploading, U] = useState(""),
    [job, J] = useState(""),
    [logs, Log] = useState(""),
    [artifacts, Art] = useState([]),
    [now, Now] = useState(Date.now()),
    [model, Model] = useState(""),
    [effort, Effort] = useState("high"),
    [features, Features] = useState({}),
    [attached, Attached] = useState([]),
    [attachmentNames, AttachmentNames] = useState({}),
    [slashHidden, SlashHidden] = useState(false);
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
      Server((v) => v || "__chat__");
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
  const listed = boot?.sessions.find((s) => s.id === active),
    viewed = views[active]?.session,
    current = listed && (viewed?.rev > listed.rev ? viewed : listed),
    rows = views[active]?.rows || [],
    projects = [
      ...new Set((boot?.sessions || []).map((s) => s.project).filter(Boolean)),
    ].sort(),
    managed = boot?.sessions.find((s) => s.id === manageId);
  const revealSettings = (tools = false) => {
    SettingsOpen(true);
    if (tools) ToolsOpen(true);
  };
  const sessionChanged = (id, result) => {
    if (result.deleted) {
      if (active === id) choose("");
      const next = { ...viewsRef.current };
      delete next[id];
      delete cursors.current[id];
      viewsRef.current = next;
      V(next);
      S((old) => ({
        ...old,
        sessions: old.sessions.filter((s) => s.id !== id),
      }));
      if (result.cleanupPending)
        Notice("会话已删除；部分缓存正在被占用，下次启动面板时继续清理。");
    } else {
      S((old) => ({
        ...old,
        sessions: old.sessions.map((s) =>
          s.id === id ? { ...s, ...result } : s,
        ),
      }));
      if (viewsRef.current[id]) {
        const next = {
          ...viewsRef.current,
          [id]: {
            ...viewsRef.current[id],
            session: { ...viewsRef.current[id].session, ...result },
          },
        };
        viewsRef.current = next;
        V(next);
      }
    }
    refresh();
  };
  useEffect(() => {
    Model(current?.model || "");
    Effort(current?.effort || "high");
    Features(current?.features || boot?.featureDefaults || {});
  }, [
    active,
    current?.model,
    current?.effort,
    JSON.stringify(current?.features),
  ]);
  useEffect(() => {
    if (!active) return;
    let done = false;
    api("sessions/" + active + "/attachments")
      .then((d) => {
        if (!done)
          AttachmentNames(
            Object.fromEntries(d.files.map((f) => [f.id, f.name])),
          );
      })
      .catch(() => {});
    return () => {
      done = true;
    };
  }, [active, rows.length]);
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
            (d.truncated ? "[较旧日志已轮替]\n" : "") +
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
    SettingsOpen(false);
    ToolsOpen(false);
    Menu(false);
    T("conversation");
    J("");
    E("");
    M("");
    Attached([]);
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
        attachments: attached.map((x) => x.id),
        requestId: requestId.current,
      });
      M("");
      Attached([]);
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
    const target = active;
    E("");
    try {
      const done = await uploadFile({
        session: target,
        file,
        attachment: true,
        progress: U,
      });
      if (activeRef.current === target) {
        Attached((xs) =>
          xs.some((x) => x.id === done.id) ? xs : [...xs, done],
        );
        AttachmentNames((xs) => ({ ...xs, [done.id]: done.name }));
      }
    } catch (e) {
      E(e.message + " · 重选同一文件可接续");
    } finally {
      U("");
    }
  }
  if (login) return <Login onLogin={refresh} />;
  if (!boot)
    return (
      <div className="loading">
        <span className="star-mark">✦</span>正在连接 Starport Pi…
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
          aria-label="开启会话列表"
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
            {health?.ready ? "已连接" : "待设置"}
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
            title="部署与管理"
            aria-label="部署与管理"
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
        <SetupBoundary>
          <Suspense fallback={<p className="loading">正在加载管理界面…</p>}>
            <Setup
              guideOnly={guide}
              onClose={() => {
                SetupView(false);
                refresh();
              }}
              onChange={refresh}
            />
          </Suspense>
        </SetupBoundary>
      ) : (
        <div className="shell">
          <aside className={"sidebar " + (showMenu ? "visible" : "")}>
            <button className="primary new-session" onClick={() => New(true)}>
              <Icon name="plus" />
              新增会话
            </button>
            <SessionList
              sessions={boot.sessions}
              active={active}
              onSelect={choose}
              onManage={Manage}
            />
            <button
              className="sidebar-bottom"
              onClick={() => {
                G(false);
                SetupView(true);
              }}
            >
              <Icon name="settings" />
              部署与管理
            </button>
          </aside>
          <main className="workspace">
            {!current ? (
              <div className="empty">
                <div className="star-mark">✦</div>
                <h1>开始你的下一段探索</h1>
                <p>开始聊天，或在隔离项目中开发。</p>
                <button className="primary" onClick={() => New(true)}>
                  新增会话
                </button>
              </div>
            ) : (
              <>
                <div className="view-heading">
                  <div>
                    <div className="conversation-title">
                      <h1>{current.title}</h1>
                      <button
                        className="icon"
                        aria-label="管理当前会话"
                        title="管理会话"
                        onClick={() => Manage(active)}
                      >
                        ⋯
                      </button>
                    </div>
                    <p>
                      {current.project && <span>{current.project} · </span>}
                      {current.mode === "chat"
                        ? "纯聊天"
                        : boot.serverKinds?.[current.server] === "wsl"
                          ? "本机隔离项目"
                          : current.server + " · 远端项目"}
                    </p>
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
                <nav className="tabs" aria-label="工作区">
                  <button
                    className={tab === "conversation" ? "active" : ""}
                    onClick={() => T("conversation")}
                  >
                    对话
                  </button>
                  <button
                    disabled={current.mode === "chat"}
                    className={tab === "tasks" ? "active" : ""}
                    onClick={() => {
                      T("tasks");
                      J((j) => j || current.jobs.at(-1)?.id || "");
                    }}
                  >
                    任务 <span>{current.jobs.length}</span>
                  </button>
                  <button
                    className={tab === "usage" ? "active" : ""}
                    onClick={() => T("usage")}
                  >
                    用量
                  </button>
                  <button
                    disabled={current.mode === "chat"}
                    className={tab === "files" ? "active" : ""}
                    onClick={() => T("files")}
                  >
                    文件
                  </button>
                </nav>
                {(error || current.error) && (
                  <div role="alert" className="error">
                    {error || current.error}
                  </div>
                )}
                {tab === "usage" && (
                  <PreviewBoundary>
                    <Suspense fallback={<p>加载用量…</p>}>
                      <Usage session={active} />
                    </Suspense>
                  </PreviewBoundary>
                )}
                {tab === "conversation" && (
                  <>
                    <details
                      className="conversation-settings"
                      open={settingsOpen}
                      onToggle={(e) => SettingsOpen(e.currentTarget.open)}
                    >
                      <summary>
                        <Icon name="settings" />
                        <span>
                          {boot.models.find((m) => m.id === current.model)
                            ?.name || current.model}{" "}
                          · {current.effort}
                        </span>
                        <span className="settings-toggle">
                          {settingsOpen ? "收起" : "设置"}
                        </span>
                      </summary>
                      <form
                        className="modelbar"
                        onSubmit={async (e) => {
                          e.preventDefault();
                          try {
                            const result = await api(
                              "sessions/" + active + "/settings",
                              {
                                model,
                                effort,
                                features,
                              },
                            );
                            sessionChanged(active, result);
                            SettingsOpen(false);
                          } catch (e) {
                            E(e.message);
                          }
                        }}
                      >
                        <label>
                          模型
                          <select
                            aria-label="模型"
                            value={model}
                            onChange={(e) => Model(e.target.value)}
                            disabled={working || Boolean(current.archivedAt)}
                          >
                            {(boot.models || []).map((m) => (
                              <option value={m.id} key={m.id}>
                                {m.name}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          Effort
                          <select
                            aria-label="Effort"
                            value={effort}
                            onChange={(e) => Effort(e.target.value)}
                            disabled={working || Boolean(current.archivedAt)}
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
                        <SessionFeatures
                          open={toolsOpen}
                          onToggle={ToolsOpen}
                          value={features}
                          onChange={Features}
                          addons={boot.addons}
                          disabled={working || Boolean(current.archivedAt)}
                        />
                        <button
                          disabled={working || Boolean(current.archivedAt)}
                        >
                          应用
                        </button>
                      </form>
                    </details>
                    <div className="messages">
                      {rows.map((row) => (
                        <PreviewBoundary key={row.id}>
                          <Message
                            row={row}
                            session={active}
                            attachmentNames={attachmentNames}
                          />
                        </PreviewBoundary>
                      ))}
                      {!rows.length && (
                        <p className="muted empty-message">
                          {current.mode === "chat"
                            ? "开始对话，无需连接服务器。"
                            : "说明目标，或附加项目文件开始。"}
                        </p>
                      )}
                      <div ref={end} />
                    </div>
                    {current.archivedAt ? (
                      <div className="archived-banner">
                        <span>此会话已归档</span>
                        <button
                          onClick={async () => {
                            try {
                              sessionChanged(
                                active,
                                await api("sessions/" + active + "/metadata", {
                                  archived: false,
                                }),
                              );
                            } catch (e) {
                              E(e.message);
                            }
                          }}
                        >
                          恢复并继续
                        </button>
                      </div>
                    ) : (
                      <form className="composer" onSubmit={send}>
                        {!slashHidden && /^\/[^\s]*$/.test(message) && (
                          <SlashMenu
                            query={message}
                            addons={boot.addons}
                            mode={current.mode}
                            onDismiss={() => SlashHidden(true)}
                            onSelect={async (x) => {
                              M("");
                              SlashHidden(true);
                              if (x.kind === "command") {
                                if (x.id === "help") {
                                  G(true);
                                  SetupView(true);
                                } else if (x.id === "new") New(true);
                                else if (x.id === "stop") {
                                  try {
                                    await api(
                                      "sessions/" + active + "/stop",
                                      {},
                                    );
                                  } catch (e) {
                                    E(e.message);
                                  }
                                } else if (["model", "tools"].includes(x.id)) {
                                  revealSettings(x.id === "tools");
                                } else T(x.id === "jobs" ? "tasks" : x.id);
                              } else if (
                                ["skills", "plugins", "mcp"].includes(x.kind)
                              ) {
                                const next = {
                                  ...features,
                                  [x.kind]: [
                                    ...new Set([
                                      ...(features[x.kind] || []),
                                      x.member,
                                    ]),
                                  ],
                                };
                                Features(next);
                                revealSettings(true);
                              } else if (x.kind === "native") {
                                const k = {
                                  web_search: "webSearch",
                                  web_fetch: "webFetch",
                                  code_execution: "codeExecution",
                                }[x.id];
                                Features({ ...features, [k]: true });
                                revealSettings(true);
                              } else M("Please use " + x.id + " to ");
                            }}
                          />
                        )}
                        {attached.length > 0 && (
                          <div className="attached-list">
                            {attached.map((x) => (
                              <span key={x.id}>
                                {x.name}
                                <button
                                  type="button"
                                  aria-label={"移除 " + x.name}
                                  onClick={() =>
                                    Attached((xs) =>
                                      xs.filter((i) => i.id !== x.id),
                                    )
                                  }
                                >
                                  ×
                                </button>
                              </span>
                            ))}
                          </div>
                        )}
                        <input
                          hidden
                          ref={fileInput}
                          type="file"
                          multiple
                          onChange={async (e) => {
                            const files = [...e.target.files];
                            e.target.value = "";
                            for (const file of files) await upload(file);
                          }}
                        />
                        <button
                          type="button"
                          className="attach"
                          aria-label="附加"
                          disabled={Boolean(uploading) || working}
                          onClick={() => fileInput.current.click()}
                        >
                          <Icon name="clip" />
                          <span>附加</span>
                        </button>
                        <textarea
                          aria-label="消息"
                          placeholder="发送消息…"
                          value={message}
                          onChange={(e) => {
                            M(e.target.value);
                            SlashHidden(false);
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
                              api("sessions/" + active + "/stop", {}).catch(
                                (e) => E(e.message),
                              )
                            }
                          >
                            停止回复
                          </button>
                        ) : (
                          <button
                            className="primary"
                            aria-label="发送"
                            disabled={
                              sending || !message.trim() || Boolean(uploading)
                            }
                          >
                            <Icon name="send" />
                            <span>发送</span>
                          </button>
                        )}
                        {uploading && (
                          <small className="upload-progress" role="status">
                            {uploading}
                          </small>
                        )}
                      </form>
                    )}
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
                            {j.released ? "资源已释放" : "资源待确认"}
                          </small>
                        </button>
                      ))}
                    </div>
                    {job ? (
                      <>
                        <div className="task-toolbar">
                          <b>即时日志</b>
                          <a
                            href={
                              "data:text/plain;charset=utf-8," +
                              encodeURIComponent(logs)
                            }
                            download={"logs-" + job.slice(0, 8) + ".txt"}
                          >
                            下载已加载日志
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
                              取消此任务
                            </button>
                          )}
                        </div>
                        <pre className="logs">{logs || "等待日志…"}</pre>
                        <div className="artifact-list">
                          <h3>产物</h3>
                          <button
                            onClick={() =>
                              api(
                                "sessions/" + active + "/artifacts?job=" + job,
                              )
                                .then((d) => Art(d.artifacts))
                                .catch((e) => E(e.message))
                            }
                          >
                            更新产物
                          </button>
                          {artifacts.map((f) => (
                            <AttachmentCard
                              key={f.path}
                              name={f.path.split("/").at(-1)}
                              href={fileUrl(active, f.path, job)}
                            />
                          ))}
                        </div>
                      </>
                    ) : (
                      <p className="muted">
                        还没有任务。可在对话中要求执行验证或训练。
                      </p>
                    )}
                  </section>
                )}
                {tab === "files" && (
                  <PreviewBoundary>
                    <Suspense fallback={<p>读取工作区…</p>}>
                      <WorkspaceFiles
                        key={active}
                        session={active}
                        working={working}
                      />
                    </Suspense>
                  </PreviewBoundary>
                )}
              </>
            )}
          </main>
          <aside className="activity">
            <h2>任务动态</h2>
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
              <p className="muted">新的执行记录会显示于此。</p>
            )}
            <div className="resource">
              <h3>
                {current?.mode === "chat"
                  ? "纯聊天"
                  : current?.server || "项目环境"}
              </h3>
              {current?.mode === "chat" ? (
                <p>无需服务器</p>
              ) : health?.ready ? (
                <>
                  <p>
                    {health.cpus} CPU · {health.memoryGiB} GiB
                  </p>
                  <p>
                    {health.gpus} GPU{" "}
                    <span className="badge">
                      {health.networkReady ? "出口已连接" : "出口离线"}
                    </span>
                  </p>
                </>
              ) : (
                <p>尚未连接</p>
              )}
            </div>
          </aside>
        </div>
      )}
      {notice && (
        <div className="notice" role="status">
          {notice}
          <button onClick={() => Notice("")}>关闭</button>
        </div>
      )}
      {managed && (
        <SessionManager
          key={managed.id}
          session={managed}
          projects={projects}
          onClose={() => Manage("")}
          onChange={sessionChanged}
        />
      )}
      {newOpen && (
        <div className="modal-backdrop">
          <form
            className="card modal"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                const s = await api("sessions", { title, server, project });
                await refresh();
                choose(s.id);
                Title("");
                Project("");
                New(false);
              } catch (e) {
                E(e.message);
              }
            }}
          >
            <h2>新增会话</h2>
            <label className="field">
              会话名称
              <input
                autoFocus
                value={title}
                onChange={(e) => Title(e.target.value)}
                required
                maxLength="100"
              />
            </label>
            <label className="field">
              项目
              <input
                list="new-projects"
                value={project}
                onChange={(e) => Project(e.target.value)}
                placeholder="选择或输入项目，留空则不分组"
                maxLength="80"
              />
              <datalist id="new-projects">
                {projects.map((p) => (
                  <option key={p} value={p} />
                ))}
              </datalist>
            </label>
            <label className="field">
              执行环境
              <select
                value={server}
                onChange={(e) => Server(e.target.value)}
                required
              >
                <option value="__chat__">纯聊天 · 无需服务器</option>
                {boot.servers.map((s) => (
                  <option key={s} value={s}>
                    {boot.serverKinds?.[s] === "wsl"
                      ? "本机隔离项目"
                      : s + " · 远端项目"}
                  </option>
                ))}
              </select>
            </label>
            {error && <p className="error">{error}</p>}
            <div className="form-row">
              <button type="button" onClick={() => New(false)}>
                取消
              </button>
              <button className="primary">建立</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")).render(<App />);
