import React, { useEffect, useRef, useState } from "react";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import worker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
GlobalWorkerOptions.workerSrc = worker;
const cmaps = import.meta.glob("../../node_modules/pdfjs-dist/cmaps/*.bcmap", {
  query: "?url",
  import: "default",
  eager: true,
});
const fonts = import.meta.glob(
  "../../node_modules/pdfjs-dist/standard_fonts/*.{pfb,ttf}",
  { query: "?url", import: "default", eager: true },
);
function asset(map, name) {
  const url = Object.entries(map).find(
    ([k]) => k.split("/").at(-1) === name,
  )?.[1];
  if (!url) throw new Error("pdf_font_unavailable");
  if (url.startsWith("data:")) {
    const [head, body] = url.split(",");
    const raw = head.endsWith(";base64")
      ? atob(body)
      : decodeURIComponent(body);
    return Promise.resolve(Uint8Array.from(raw, (c) => c.charCodeAt(0)));
  }
  return fetch(url, { credentials: "same-origin" })
    .then((r) => {
      if (!r.ok) throw new Error("pdf_font_unavailable");
      return r.arrayBuffer();
    })
    .then((b) => new Uint8Array(b));
}
class CMaps {
  async fetch({ name }) {
    return {
      cMapData: await asset(cmaps, name + ".bcmap"),
      compressionType: 1,
    };
  }
}
class Fonts {
  fetch({ filename }) {
    return asset(fonts, filename);
  }
}
export default function PdfPreview({ url, name }) {
  const [pdf, P] = useState(null),
    [page, Page] = useState(1),
    [error, E] = useState(""),
    [ready, R] = useState(false),
    canvas = useRef();
  useEffect(() => {
    if (!url.startsWith("/api/sessions/")) {
      E("invalid_preview_url");
      return;
    }
    let gone = false;
    P(null);
    E("");
    R(false);
    Page(1);
    const task = getDocument({
      url,
      withCredentials: true,
      isEvalSupported: false,
      useWasm: false,
      useSystemFonts: false,
      useWorkerFetch: false,
      CMapReaderFactory: CMaps,
      StandardFontDataFactory: Fonts,
    });
    task.promise
      .then((p) => {
        if (!gone) P(p);
      })
      .catch(() => {
        if (!gone) E("PDF 无法预览，请下载原文件查看。");
      });
    return () => {
      gone = true;
      task.destroy();
    };
  }, [url]);
  useEffect(() => {
    if (!pdf || !canvas.current) return;
    let gone = false,
      render;
    R(false);
    pdf
      .getPage(page)
      .then((p) => {
        if (gone) return;
        const unit = p.getViewport({ scale: 1 });
        const width = Math.min(
          canvas.current.parentElement.clientWidth || 700,
          1000,
        );
        const scale = Math.min(
          (width / unit.width) * Math.min(devicePixelRatio || 1, 2),
          Math.sqrt(8e6 / (unit.width * unit.height)),
          4000 / Math.max(unit.width, unit.height),
        );
        const view = p.getViewport({ scale });
        canvas.current.width = Math.floor(view.width);
        canvas.current.height = Math.floor(view.height);
        render = p.render({
          canvasContext: canvas.current.getContext("2d"),
          viewport: view,
        });
        return render.promise;
      })
      .then(() => {
        if (!gone) R(true);
      })
      .catch(() => {
        if (!gone) E("PDF 页面渲染失败，可下载原文件。");
      });
    return () => {
      gone = true;
      render?.cancel();
    };
  }, [pdf, page]);
  return (
    <section className="pdf-preview" aria-label={name}>
      <div className="pdf-toolbar">
        <button
          type="button"
          disabled={!pdf || page <= 1}
          onClick={() => Page((n) => n - 1)}
        >
          上一页
        </button>
        <span>
          {page} / {pdf?.numPages || "…"}
        </span>
        <button
          type="button"
          disabled={!pdf || page >= pdf.numPages}
          onClick={() => Page((n) => n + 1)}
        >
          下一页
        </button>
      </div>
      {error ? (
        <p role="alert">{error}</p>
      ) : (
        <>
          <canvas ref={canvas} aria-label={`PDF 第 ${page} 页`} />
          {!ready && <p role="status">正在渲染 PDF…</p>}
        </>
      )}
    </section>
  );
}
