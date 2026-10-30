import React, { useEffect, useRef, useState } from "react";
import { api, fileUrl } from "./api";
import { uploadFile } from "./uploads";
import AttachmentCard from "./AttachmentCard";

const errors = {
  file_exists: "已有同名文件或文件夹，请换一个名称。",
  file_not_found: "文件或目标文件夹不存在，请刷新后重试。",
  file_permission_denied: "此文件不可修改，请检查工作区内的文件权限。",
  file_changed_refresh: "文件已经变更，请刷新后重试，避免覆盖新内容。",
  workspace_busy:
    "工作区任务尚未释放。已上传分块会保留，结束后重选同一文件可继续。",
  session_busy: "会话正在回复，请稍后再修改文件。",
  worker_update_required: "请先在服务器管理页更新执行器，启用工作区文件管理。",
  unsupported_operation: "当前执行器不支持此操作，请在服务器管理页更新执行器。",
  text_file_too_large_or_binary:
    "仅可编辑 2 MiB 以内的 UTF-8 文本；此文件仍可下载。",
  invalid_path: "请输入工作区内的相对路径，不能使用 .. 或绝对路径。",
};
const explain = (e) => errors[e.message] || e.message;
const size = (n) =>
  n < 1024
    ? `${n} B`
    : n < 1048576
      ? `${(n / 1024).toFixed(1)} KiB`
      : `${(n / 1048576).toFixed(1)} MiB`;

function FileDialog({ session, entry, onClose, onDone }) {
  const dialog = useRef();
  const [name, Name] = useState(entry.path);
  const [content, Content] = useState("");
  const [version, Version] = useState(entry.version);
  const [error, Error] = useState("");
  const [busy, Busy] = useState(entry.action === "edit");
  const [loaded, Loaded] = useState(entry.action !== "edit");
  useEffect(() => {
    const el = dialog.current,
      abort = new AbortController();
    el.showModal();
    if (entry.action === "edit")
      api(
        `sessions/${session}/file-text?` +
          new URLSearchParams({ path: entry.path }),
        undefined,
        abort.signal,
      )
        .then((r) => {
          if (!abort.signal.aborted) {
            Content(r.text);
            Version(r.version);
            Loaded(true);
          }
        })
        .catch((e) => {
          if (!abort.signal.aborted) Error(explain(e));
        })
        .finally(() => {
          if (!abort.signal.aborted) Busy(false);
        });
    return () => {
      abort.abort();
      el.close();
    };
  }, []);
  const titles = {
    mkdir: "新建文件夹",
    new: "新建文本文件",
    edit: "编辑文件",
    rename: "重命名或移动",
    delete: "删除文件",
  };
  return (
    <dialog
      ref={dialog}
      className={
        "card file-dialog " +
        (["edit", "new"].includes(entry.action) ? "editor" : "")
      }
      aria-labelledby="file-dialog-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy || !loaded) return;
          Busy(true);
          Error("");
          try {
            const action = ["new", "edit"].includes(entry.action)
              ? "save"
              : entry.action;
            await api(`sessions/${session}/file-manage`, {
              action,
              path: ["new", "mkdir"].includes(entry.action) ? name : entry.path,
              ...(version ? { version } : {}),
              ...(action === "rename" ? { destination: name } : {}),
              ...(action === "save" ? { content } : {}),
              ...(action === "delete" ? { confirmPath: entry.path } : {}),
            });
            onDone();
            onClose();
          } catch (e) {
            Error(explain(e));
          } finally {
            Busy(false);
          }
        }}
      >
        <h2 id="file-dialog-title">{titles[entry.action]}</h2>
        {entry.action === "delete" ? (
          <p>
            永久删除 <b>{entry.path}</b>
            {entry.kind === "directory" ? " 及其中全部内容" : ""}
            ？此操作无法撤销。
          </p>
        ) : (
          <label className="field">
            {entry.action === "edit" ? "文件路径" : "工作区相对路径"}
            <input
              autoFocus
              value={name}
              onChange={(e) => Name(e.target.value)}
              required
              readOnly={entry.action === "edit"}
              disabled={busy}
              maxLength="1024"
            />
          </label>
        )}
        {["new", "edit"].includes(entry.action) && (
          <label className="field">
            文件内容
            <textarea
              className="file-editor"
              value={content}
              onChange={(e) => Content(e.target.value)}
              disabled={busy || !loaded}
              spellCheck="false"
              rows="14"
            />
          </label>
        )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="form-row">
          <button type="button" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            className={entry.action === "delete" ? "danger" : "primary"}
            disabled={busy || !loaded}
          >
            {busy ? "处理中…" : entry.action === "delete" ? "确认删除" : "保存"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

export default function WorkspaceFiles({ session, working }) {
  const [directory, Directory] = useState(".");
  const [files, Files] = useState([]),
    [capable, Capable] = useState(false);
  const [revision, Refresh] = useState(0),
    [loading, Loading] = useState(true);
  const [error, Error] = useState(""),
    [uploading, Uploading] = useState("");
  const [editing, Editing] = useState(null);
  const fileInput = useRef();
  const at = (name) => (directory === "." ? "" : directory + "/") + name;
  const navigate = (path) => {
    Error("");
    Directory(path);
  };
  useEffect(() => {
    const abort = new AbortController();
    Loading(true);
    api(
      `sessions/${session}/files?` + new URLSearchParams({ path: directory }),
      undefined,
      abort.signal,
    )
      .then((r) => {
        if (!abort.signal.aborted) {
          Files(r.entries);
          Capable(Boolean(r.capabilities?.fileManagement));
        }
      })
      .catch((e) => {
        if (!abort.signal.aborted) {
          Error(explain(e));
          Files([]);
          Capable(false);
        }
      })
      .finally(() => {
        if (!abort.signal.aborted) Loading(false);
      });
    return () => abort.abort();
  }, [session, directory, revision]);
  const disabled = loading || working || Boolean(uploading) || !capable;
  return (
    <section className="files">
      <nav className="file-breadcrumbs" aria-label="文件路径">
        <button onClick={() => navigate(".")}>/workspace</button>
        {(directory === "." ? [] : directory.split("/")).map(
          (part, i, parts) => (
            <React.Fragment key={i}>
              <span>/</span>
              <button onClick={() => navigate(parts.slice(0, i + 1).join("/"))}>
                {part}
              </button>
            </React.Fragment>
          ),
        )}
      </nav>
      <div className="file-toolbar">
        <button
          onClick={() => {
            Error("");
            Refresh((x) => x + 1);
          }}
          disabled={loading}
        >
          刷新
        </button>
        <button
          onClick={() =>
            navigate(directory.split("/").slice(0, -1).join("/") || ".")
          }
          disabled={directory === "."}
        >
          上一级
        </button>
        <button onClick={() => fileInput.current.click()} disabled={disabled}>
          上传文件
        </button>
        <button
          onClick={() => Editing({ action: "mkdir", path: at("") })}
          disabled={disabled}
        >
          新建文件夹
        </button>
        <button
          onClick={() => Editing({ action: "new", path: at("") })}
          disabled={disabled}
        >
          新建文本文件
        </button>
        <input
          hidden
          ref={fileInput}
          type="file"
          multiple
          onChange={async (e) => {
            const selected = [...e.target.files],
              destination = directory;
            e.target.value = "";
            Error("");
            try {
              for (const file of selected)
                await uploadFile({
                  session,
                  file,
                  directory: destination,
                  progress: Uploading,
                });
            } catch (e) {
              Error(explain(e));
            } finally {
              Uploading("");
              Refresh((x) => x + 1);
            }
          }}
        />
      </div>
      {uploading && <p role="status">{uploading}</p>}
      {!loading && !capable && !error && (
        <p className="muted">更新执行器后可管理文件；当前仍可浏览和下载。</p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {loading ? (
        <p role="status">读取文件…</p>
      ) : (
        files.map((f) => (
          <div className="workspace-file" key={f.name}>
            <div className="workspace-file-name">
              {f.kind === "directory" ? (
                <button onClick={() => navigate(at(f.name))}>
                  ▸ {f.name}/
                </button>
              ) : (
                <b>{f.name}</b>
              )}
              <small>{f.kind === "directory" ? "文件夹" : size(f.bytes)}</small>
            </div>
            <div className="workspace-file-actions">
              {f.kind === "file" && (
                <button
                  disabled={disabled}
                  onClick={() =>
                    Editing({ ...f, path: at(f.name), action: "edit" })
                  }
                >
                  编辑
                </button>
              )}
              <button
                disabled={disabled}
                onClick={() =>
                  Editing({ ...f, path: at(f.name), action: "rename" })
                }
              >
                重命名 / 移动
              </button>
              <button
                className="danger"
                disabled={disabled}
                onClick={() =>
                  Editing({ ...f, path: at(f.name), action: "delete" })
                }
              >
                删除
              </button>
            </div>
            {f.kind === "file" && (
              <AttachmentCard
                name={f.name}
              showName={false}
                href={fileUrl(session, at(f.name))}
              />
            )}
          </div>
        ))
      )}
      {!loading && !error && !files.length && (
        <p className="muted">此文件夹为空。</p>
      )}
      {editing && (
        <FileDialog
          session={session}
          entry={editing}
          onClose={() => Editing(null)}
          onDone={() => Refresh((x) => x + 1)}
        />
      )}
    </section>
  );
}
