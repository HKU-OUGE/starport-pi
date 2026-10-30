import React, { useEffect, useState } from "react";
import { setup } from "./api";
const blank = (kind) => ({
  id: "",
  label: "",
  enabled: false,
  ...(kind === "skills"
    ? { content: "" }
    : kind === "mcp"
      ? { url: "", token: "", tools: [] }
      : { description: "", skills: [], mcp: [] }),
});
export default function Extensions({ onChange }) {
  const [data, D] = useState({ skills: [], mcp: [], plugins: [] }),
    [kind, K] = useState("skills"),
    [item, I] = useState(blank("skills")),
    [error, E] = useState(""),
    [busy, B] = useState(false);
  const refresh = () =>
    setup("addons-list")
      .then(D)
      .catch((e) => E(e.message));
  useEffect(() => {
    refresh();
  }, []);
  async function save(e) {
    e.preventDefault();
    B(true);
    E("");
    try {
      D(
        await setup("addons-save", {
          kind,
          item:
            kind === "mcp"
              ? {
                  ...item,
                  tools: item.tools.map((x) => x.trim()).filter(Boolean),
                }
              : item,
        }),
      );
      I(blank(kind));
      onChange?.();
    } catch (e) {
      E(e.message);
    } finally {
      B(false);
    }
  }
  const set = (k, v) => I((x) => ({ ...x, [k]: v }));
  return (
    <section>
      <nav className="tabs">
        {[
          ["skills", "Skills"],
          ["plugins", "插件"],
          ["mcp", "MCP"],
        ].map(([k, label]) => (
          <button
            key={k}
            onClick={() => {
              K(k);
              I(blank(k));
              E("");
            }}
            className={kind === k ? "active" : ""}
          >
            {label}
          </button>
        ))}
      </nav>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="settings-grid">
        <div className="card">
          <h2>已配置</h2>
          {!data[kind].length && <p className="muted">还没有条目。</p>}
          {data[kind].map((x) => (
            <div className="list-row" key={x.id}>
              <button
                onClick={() => {
                  const { tokenConfigured, ...fields } = x;
                  I({ ...fields, ...(kind === "mcp" ? { token: "" } : {}) });
                }}
              >
                {x.label}
              </button>
              <span className="badge">{x.enabled ? "可启用" : "停用"}</span>
              <button
                onClick={async () => {
                  try {
                    D(await setup("addons-remove", { kind, id: x.id }));
                    onChange?.();
                  } catch (e) {
                    E(e.message);
                  }
                }}
              >
                删除
              </button>
            </div>
          ))}
        </div>
        <form className="card" onSubmit={save}>
          <h2>{item.id ? "配置条目" : "添加条目"}</h2>
          <label className="field">
            ID
            <input
              value={item.id}
              onChange={(e) => set("id", e.target.value)}
              placeholder="research"
              required
              pattern="[a-z][a-z0-9-]{0,39}"
            />
          </label>
          <label className="field">
            名称
            <input
              value={item.label}
              onChange={(e) => set("label", e.target.value)}
              required
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={item.enabled}
              onChange={(e) => set("enabled", e.target.checked)}
            />
            允许会话选择
          </label>
          {kind === "skills" && (
            <>
              <label className="field">
                Skill 内容
                <textarea
                  value={item.content}
                  onChange={(e) => set("content", e.target.value)}
                  rows="12"
                  required
                />
              </label>
              <label className="file-button">
                导入 SKILL.md
                <input
                  type="file"
                  accept=".md,.txt"
                  onChange={async (e) => {
                    const f = e.target.files[0];
                    if (f?.size <= 32000) set("content", await f.text());
                    else E("invalid_skill_content");
                    e.target.value = "";
                  }}
                />
              </label>
            </>
          )}
          {kind === "mcp" && (
            <>
              <label className="field">
                HTTPS MCP 地址
                <input
                  type="url"
                  value={item.url}
                  onChange={(e) => set("url", e.target.value)}
                  placeholder="https://mcp.example.com/mcp"
                  required
                />
              </label>
              <label className="field">
                Bearer token
                <input
                  type="password"
                  autoComplete="off"
                  value={item.token || ""}
                  placeholder="留空保留已存凭据"
                  onChange={(e) => set("token", e.target.value)}
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={item.clearToken || false}
                  onChange={(e) => set("clearToken", e.target.checked)}
                />
                清除已存 token
              </label>
              <label className="field">
                允许的工具名称（每行一个）
                <textarea
                  value={(item.tools || []).join("\n")}
                  onChange={(e) => set("tools", e.target.value.split("\n"))}
                  required
                />
              </label>
            </>
          )}
          {kind === "plugins" && (
            <>
              <label className="field">
                描述
                <textarea
                  value={item.description}
                  onChange={(e) => set("description", e.target.value)}
                  required
                />
              </label>
              {["skills", "mcp"].map((k) => (
                <fieldset key={k}>
                  <legend>{k === "skills" ? "Skills" : "MCP"}</legend>
                  {data[k].map((x) => (
                    <label className="field" key={x.id}>
                      <span>
                        <input
                          type="checkbox"
                          checked={item[k]?.includes(x.id)}
                          onChange={(e) =>
                            set(
                              k,
                              e.target.checked
                                ? [...item[k], x.id]
                                : item[k].filter((n) => n !== x.id),
                            )
                          }
                        />
                        {x.label}
                      </span>
                    </label>
                  ))}
                </fieldset>
              ))}
              <label className="file-button">
                导入插件 JSON
                <input
                  type="file"
                  accept=".json"
                  onChange={async (e) => {
                    try {
                      const f = e.target.files[0];
                      if (!f || f.size > 64000)
                        throw new Error("plugin_too_large");
                      const parsed = JSON.parse(await f.text());
                      I({ ...parsed, enabled: false });
                    } catch (err) {
                      E(err.message);
                    }
                    e.target.value = "";
                  }}
                />
              </label>
              <button
                type="button"
                onClick={() => {
                  const url = URL.createObjectURL(
                    new Blob([JSON.stringify(item, null, 2)], {
                      type: "application/json",
                    }),
                  );
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = (item.id || "plugin") + ".json";
                  a.click();
                  setTimeout(() => URL.revokeObjectURL(url), 1000);
                }}
              >
                导出插件
              </button>
            </>
          )}
          <button className="primary" disabled={busy}>
            保存
          </button>
          <button type="button" onClick={() => I(blank(kind))}>
            新建
          </button>
        </form>
      </div>
      <details className="card">
        <summary>扩展指引</summary>
        <p>
          Skill 是可查看的提示词内容。插件把现有 Skills 与 MCP
          组合起来，不运行本机脚本、安装包或钩子。保存后仍需在会话中选择并应用。
        </p>
        <p>
          MCP 使用 Anthropic 的远端 HTTPS 连接器，支持 Streamable HTTP /
          SSE。请填写工具允许列表。URL、专用 token 和工具调用会交给 Anthropic
          及对应 MCP 服务；不要填管理电脑的私钥或管理员凭据。此入口不支持本机
          stdio。
        </p>
        <p>
          停用或修改配置会在下一轮生效，正在运行的请求继续完成。导入不会自动启用条目。
        </p>
      </details>
    </section>
  );
}
