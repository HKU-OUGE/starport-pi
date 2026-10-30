import React, { useEffect, useState } from "react";
export function slashItems(addons, mode) {
  const commands = [
    ["model", "模型与工具设置"],
    ["usage", "用量和速率余量"],
    ["tools", "查看工具"],
    ["help", "打开指引"],
    ["stop", "停止当前回复"],
    ["new", "新建会话"],
  ];
  if (mode !== "chat")
    commands.push(["files", "项目文件"], ["jobs", "任务与日志"]);
  const rows = commands.map(([id, label]) => ({ id, label, kind: "command" }));
  for (const kind of ["skills", "plugins", "mcp"])
    for (const x of addons?.[kind] || [])
      if (x.enabled)
        rows.push({ ...x, id: kind + ":" + x.id, member: x.id, kind });
  for (const [id, label] of [
    ["web_search", "网页搜索"],
    ["web_fetch", "网页抓取"],
    ["code_execution", "Anthropic 代码执行"],
  ])
    rows.push({ id, label, kind: "native" });
  if (mode !== "chat")
    for (const id of [
      "read",
      "write",
      "edit",
      "find",
      "grep",
      "list",
      "bash",
      "job_status",
      "job_logs",
      "artifacts",
      "datasets",
    ])
      rows.push({ id, label: "项目工具 · " + id, kind: "tool" });
  return rows;
}
export default function SlashMenu({
  query,
  addons,
  mode,
  onSelect,
  onDismiss,
}) {
  const items = slashItems(addons, mode)
    .filter((x) =>
      (x.id + " " + x.label)
        .toLowerCase()
        .includes(query.slice(1).toLowerCase()),
    )
    .slice(0, 30);
  const [index, I] = useState(0);
  useEffect(() => I(0), [query]);
  useEffect(() => {
    const key = (e) => {
      if (
        ["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(e.key) &&
        !e.isComposing
      ) {
        e.preventDefault();
        if (e.key === "Escape") onDismiss();
        else if (e.key === "Enter" && items[index]) onSelect(items[index]);
        else
          I(
            (n) =>
              (n + (e.key === "ArrowUp" ? -1 : 1) + Math.max(items.length, 1)) %
              Math.max(items.length, 1),
          );
      }
    };
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  }, [items, index, onSelect, onDismiss]);
  return (
    <div className="slash-menu" role="listbox" aria-label="命令与扩展">
      {items.length ? (
        items.map((x, i) => (
          <button
            key={x.id}
            type="button"
            role="option"
            aria-selected={i === index}
            onClick={() => onSelect(x)}
          >
            <b>/{x.id}</b>
            <span>{x.label}</span>
          </button>
        ))
      ) : (
        <p>没有匹配的工具或扩展。</p>
      )}
    </div>
  );
}
