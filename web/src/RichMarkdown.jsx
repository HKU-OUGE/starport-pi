import React from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { Converter } from "opencc-js/t2cn";
import "katex/dist/katex.min.css";
const simplify = Converter({ from: "tw", to: "cn" });
export function simplifiedProse() {
  return (tree) => {
    function visit(n) {
      if (["code", "inlineCode", "math", "inlineMath", "html"].includes(n.type))
        return;
      if (n.type === "text") n.value = simplify(n.value);
      n.children?.forEach(visit);
    }
    visit(tree);
  };
}
function projectUrl(href, session, preview) {
  if (!session || typeof href !== "string") return null;
  const clean = href.replace(/^file:\/\//, "");
  if (clean.startsWith("/workspace/"))
    return (
      `/api/sessions/${session}/download?` +
      new URLSearchParams({
        path: clean.slice(11),
        ...(preview ? { preview: "1" } : {}),
      })
    );
  if (
    !/^[a-z]+:|^\/|^#|[?#\\]/i.test(clean) &&
    clean.includes(".") &&
    !clean.split("/").some((p) => p === "..")
  )
    return (
      `/api/sessions/${session}/download?` +
      new URLSearchParams({
        path: clean.replace(/^\.\//, ""),
        ...(preview ? { preview: "1" } : {}),
      })
    );
  return null;
}
function RichMarkdown({ text = "", session }) {
  const fenced = /^\s*```(?:markdown|md)\s*\n([\s\S]*?)\n```\s*$/.exec(text);
  const components = {
    a: ({ href, children }) => {
      const link =
        projectUrl(href, session) ||
        (/^https?:\/\//.test(href || "") ? href : null);
      return link ? (
        <a href={link} target="_blank" rel="noreferrer">
          {children}
        </a>
      ) : (
        <span>{children}</span>
      );
    },
    img: ({ src, alt }) => {
      const link = projectUrl(src, session, true);
      return link ? (
        <img src={link} alt={simplify(alt || "图片")} loading="lazy" />
      ) : (
        <span className="muted">
          [图片：{simplify(alt || "附件")}]
          {/^https?:\/\//.test(src || "") && (
            <a href={src} target="_blank" rel="noreferrer">
              打开
            </a>
          )}
        </span>
      );
    },
    pre: ({ children }) => (
      <div className="code-block">
        <button
          type="button"
          onClick={(e) => {
            const text = e.currentTarget.nextSibling?.textContent;
            if (text) navigator.clipboard?.writeText(text).catch(() => {});
          }}
        >
          复制代码
        </button>
        <pre>{children}</pre>
      </div>
    ),
    table: ({ children }) => (
      <div className="table-scroll">
        <table>{children}</table>
      </div>
    ),
  };
  return (
    <div className="markdown">
      {fenced && (
        <details>
          <summary>Markdown 源文</summary>
          <pre>{fenced[1]}</pre>
        </details>
      )}
      <Markdown
        remarkPlugins={[remarkGfm, remarkMath, simplifiedProse]}
        rehypePlugins={[[rehypeKatex, { strict: false, trust: false }]]}
        components={components}
      >
        {fenced ? fenced[1] : text}
      </Markdown>
    </div>
  );
}
export default React.memo(RichMarkdown);
