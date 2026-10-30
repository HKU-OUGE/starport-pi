import React, { useState, useEffect, lazy, Suspense } from "react";
import { api } from "./api";
import PreviewBoundary from "./PreviewBoundary";
const PdfPreview = lazy(() => import("./PdfPreview"));
export default function AttachmentCard({
  session,
  id,
  name = "附件",
  cloud = false,
  href,
  showName = true,
}) {
  const [open, O] = useState(false);
  const [metadata, S] = useState(null),
    [error, E] = useState("");
  useEffect(() => {
    if (!cloud) return;
    let done = false;
    api(`sessions/${session}/cloud-file-meta?id=${encodeURIComponent(id)}`)
      .then((x) => {
        if (!done) S(x);
      })
      .catch((e) => {
        if (!done) E(e.message);
      });
    return () => {
      done = true;
    };
  }, [session, id, cloud]);
  name = metadata?.filename || name;
  const url =
    href ||
    `/api/sessions/${session}/${cloud ? "cloud-file" : "attachment"}?id=${encodeURIComponent(id)}`;
  const preview = url + "&preview=1",
    ext = name.split(".").at(-1).toLowerCase();
  return (
    <div className="attachment-card">
      <div>
        {showName && <b>{name}</b>}
        <a href={url} download>
          下载
        </a>
        <a href={preview} target="_blank" rel="noreferrer">
          打开
        </a>
        <button type="button" onClick={() => O(!open)}>
          {open ? "收起" : "预览"}
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      {open && (
        <>
          {["png", "jpg", "jpeg", "gif", "webp"].includes(ext) ? (
            <img src={preview} alt={name} loading="lazy" />
          ) : ["mp4", "webm", "mov"].includes(ext) ? (
            <video src={preview} controls preload="metadata" />
          ) : ["mp3", "wav", "ogg", "m4a"].includes(ext) ? (
            <audio src={preview} controls preload="metadata" />
          ) : ext === "pdf" ? (
            <PreviewBoundary>
              <Suspense fallback={<p>加载 PDF 查看器…</p>}>
                <PdfPreview url={preview} name={name} />
              </Suspense>
            </PreviewBoundary>
          ) : (
            <p>此格式请下载后查看，或附加给代码执行工具处理。</p>
          )}
        </>
      )}
    </div>
  );
}
