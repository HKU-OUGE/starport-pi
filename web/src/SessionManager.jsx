import React, { useEffect, useRef, useState } from "react";
import { api } from "./api";

const errors = {
  session_busy: "会话正在回复，请结束后再删除。",
  session_jobs_busy: "还有任务未结束或未确认资源释放，请稍后再删除。",
  session_transfers_busy: "会话正在传输或查询文件，请完成后重试。",
  session_not_found: "会话已被删除，请刷新列表。",
};
export default function SessionManager({
  session,
  projects,
  onClose,
  onChange,
}) {
  const dialog = useRef();
  const [title, setTitle] = useState(session.title);
  const [project, setProject] = useState(session.project || "");
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const blocked =
    ["thinking", "tool"].includes(session.status) ||
    session.jobs.some((j) => !j.released);
  useEffect(() => {
    const el = dialog.current;
    el.showModal();
    return () => el.close();
  }, []);
  async function perform(action) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await api(
        `sessions/${session.id}/${action === "delete" ? "delete" : "metadata"}`,
        action === "delete"
          ? { confirmId: session.id }
          : action === "archive"
            ? { archived: !session.archivedAt }
            : { title, project },
      );
      onChange(session.id, result);
      onClose();
    } catch (e) {
      setError(errors[e.message] || e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="card session-dialog"
      aria-labelledby="manage-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!confirm) perform("save");
        }}
      >
        <h2 id="manage-title">{confirm ? "删除会话？" : "管理会话"}</h2>
        {confirm ? (
          <>
            <p>将永久删除「{session.title}」的会话记录和本机附件缓存。</p>
            <p className="muted">
              服务器工作区、任务产物、云端文件和用量记录保留。此操作无法撤销。
            </p>
          </>
        ) : (
          <>
            <label className="field">
              会话名称
              <input
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength="100"
                required
                disabled={busy}
              />
            </label>
            <label className="field">
              项目
              <input
                list="manage-projects"
                value={project}
                onChange={(e) => setProject(e.target.value)}
                placeholder="选择或输入项目，留空则不分组"
                maxLength="80"
                disabled={busy}
              />
              <datalist id="manage-projects">
                {projects.map((p) => (
                  <option key={p} value={p} />
                ))}
              </datalist>
            </label>
            <div className="session-lifecycle">
              <button
                type="button"
                onClick={() => perform("archive")}
                disabled={busy}
              >
                {session.archivedAt ? "恢复会话" : "归档会话"}
              </button>
              <button
                type="button"
                className="danger"
                disabled={busy || blocked}
                onClick={() => setConfirm(true)}
              >
                删除…
              </button>
            </div>
            {blocked && (
              <p className="muted">
                会话仍在回复，或任务尚未确认释放，暂不能删除。
              </p>
            )}
          </>
        )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="form-row">
          <button
            type="button"
            onClick={() => (confirm ? setConfirm(false) : onClose())}
            disabled={busy}
          >
            {confirm ? "返回" : "取消"}
          </button>
          {confirm ? (
            <button
              type="button"
              className="danger"
              disabled={busy || blocked}
              onClick={() => perform("delete")}
            >
              {busy ? "正在删除…" : "确认删除"}
            </button>
          ) : (
            <button className="primary" disabled={busy || !title.trim()}>
              {busy ? "保存中…" : "保存"}
            </button>
          )}
        </div>
      </form>
    </dialog>
  );
}
