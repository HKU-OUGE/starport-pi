import React from "react";
export default function SessionFeatures({
  value,
  onChange,
  addons,
  disabled,
  open,
  onToggle,
}) {
  const set = (k, v) => onChange({ ...value, [k]: v });
  return (
    <details
      className="session-features"
      open={open}
      onToggle={(e) => onToggle(e.currentTarget.open)}
    >
      <summary>
        工具与偏好{" "}
        <span className="badge">
          {
            [
              "webSearch",
              "webFetch",
              "codeExecution",
              "advisor",
              "fast",
            ].filter((k) => value[k]).length
          }{" "}
          已选
        </span>
      </summary>
      <fieldset disabled={disabled}>
        <div className="feature-grid">
          {[
            ["webSearch", "网页搜索"],
            ["webFetch", "网页抓取"],
            ["codeExecution", "Anthropic 代码执行"],
            ["advisor", "顾问"],
            ["fast", "快速模式 · 加价"],
          ].map(([k, label]) => (
            <label key={k}>
              <input
                type="checkbox"
                checked={Boolean(value[k])}
                onChange={(e) => set(k, e.target.checked)}
              />
              {label}
            </label>
          ))}
        </div>
        <div className="feature-grid">
          <label>
            提示词缓存
            <select
              value={value.cache || "5m"}
              onChange={(e) => set("cache", e.target.value)}
            >
              <option value="off">关闭</option>
              <option value="5m">5 分钟</option>
              <option value="1h">1 小时</option>
            </select>
          </label>
          <label>
            单请求工具次数上限
            <input
              type="number"
              min="1"
              max="10"
              value={value.maxUses || 5}
              onChange={(e) => set("maxUses", Number(e.target.value))}
            />
          </label>
          {value.advisor && (
            <label>
              顾问模型
              <input
                value={value.advisorModel || "claude-opus-5-5"}
                onChange={(e) => set("advisorModel", e.target.value)}
              />
            </label>
          )}
        </div>
        {["skills", "plugins", "mcp"].map((kind) => (
          <div key={kind} className="feature-grid">
            {[
              ...(addons?.[kind] || []),
              ...(value[kind] || [])
                .filter((id) => !addons?.[kind]?.some((x) => x.id === id))
                .map((id) => ({ id, label: id, enabled: false })),
            ]
              .filter((x) => x.enabled || value[kind]?.includes(x.id))
              .map((x) => (
                <label key={x.id}>
                  <input
                    type="checkbox"
                    checked={value[kind]?.includes(x.id) || false}
                    onChange={(e) =>
                      set(
                        kind,
                        e.target.checked
                          ? [...(value[kind] || []), x.id]
                          : value[kind].filter((n) => n !== x.id),
                      )
                    }
                  />
                  {kind === "skills"
                    ? "Skill"
                    : kind === "plugins"
                      ? "插件"
                      : "MCP"}{" "}
                  · {x.label}
                  {!x.enabled && "（已停用 / 移除）"}
                </label>
              ))}
          </div>
        ))}
      </fieldset>
    </details>
  );
}
