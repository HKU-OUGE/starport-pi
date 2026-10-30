import React, { useState } from "react";

export default function SessionList({ sessions, active, onSelect, onManage }) {
  const [filter, setFilter] = useState("active");
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState(() => new Set());
  const matching = sessions.filter(
    (s) =>
      (filter === "all" || Boolean(s.archivedAt) === (filter === "archived")) &&
      `${s.title} ${s.project || ""}`
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase()),
  );
  const groups = new Map();
  for (const s of matching.toSorted(
    (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0),
  )) {
    const key = s.project || "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  return (
    <>
      <div className="session-filters" aria-label="会话筛选">
        {[
          ["active", "最近"],
          ["archived", "已归档"],
          ["all", "全部"],
        ].map(([key, label]) => (
          <button
            key={key}
            aria-pressed={filter === key}
            onClick={() => setFilter(key)}
          >
            {label}
            {key === "archived" && (
              <span>{sessions.filter((s) => s.archivedAt).length}</span>
            )}
          </button>
        ))}
      </div>
      <input
        className="session-search"
        type="search"
        aria-label="搜索会话或项目"
        placeholder="搜索会话或项目"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <nav className="session-groups" aria-label="项目与会话">
        {[...groups]
          .sort(([a], [b]) => (!a ? 1 : !b ? -1 : a.localeCompare(b)))
          .map(([project, rows]) => (
            <section className="session-group" key={project}>
              <button
                className="project-heading"
                aria-expanded={!collapsed.has(project)}
                onClick={() =>
                  setCollapsed((old) => {
                    const next = new Set(old);
                    if (next.has(project)) next.delete(project);
                    else next.add(project);
                    return next;
                  })
                }
              >
                <span aria-hidden="true">
                  {collapsed.has(project) ? "▸" : "▾"}
                </span>
                <span>{project || "未分组"}</span>
                <small>{rows.length}</small>
              </button>
              {!collapsed.has(project) &&
                rows.map((s) => (
                  <div
                    key={s.id}
                    className={
                      "session-row " + (active === s.id ? "selected" : "")
                    }
                  >
                    <button
                      className={"session " + (active === s.id ? "active" : "")}
                      aria-current={active === s.id ? "page" : undefined}
                      onClick={() => onSelect(s.id)}
                    >
                      <span>
                        {s.title}
                        <small>
                          {s.archivedAt ? "已归档 · " : ""}
                          {s.status === "thinking"
                            ? "思考中"
                            : s.status === "tool"
                              ? "执行工具"
                              : s.mode === "chat"
                                ? "纯聊天"
                                : s.server}
                        </small>
                      </span>
                    </button>
                    <button
                      className="session-more"
                      aria-label={"管理会话：" + s.title}
                      onClick={() => onManage(s.id)}
                    >
                      ⋯
                    </button>
                  </div>
                ))}
            </section>
          ))}
        {!matching.length && (
          <p className="session-empty">
            {query
              ? "没有匹配的会话"
              : filter === "archived"
                ? "还没有归档会话"
                : "还没有会话"}
          </p>
        )}
      </nav>
    </>
  );
}
