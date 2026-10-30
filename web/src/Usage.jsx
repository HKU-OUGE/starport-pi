import React, { useEffect, useState } from "react";
import { api } from "./api";
const n = (v) => Number(v || 0).toLocaleString();
export default function Usage({ session }) {
  const [data, S] = useState(null),
    [all, A] = useState(false),
    [error, E] = useState("");
  useEffect(() => {
    let done = false;
    const run = () =>
      api("usage" + (all || !session ? "" : "?session=" + session))
        .then((x) => {
          if (!done) S(x);
        })
        .catch((e) => {
          if (!done) E(e.message);
        });
    run();
    const t = setInterval(run, 10000);
    return () => {
      done = true;
      clearInterval(t);
    };
  }, [session, all]);
  return (
    <section className="usage-panel">
      <div className="task-toolbar">
        <h2>API 用量</h2>
        <label>
          <input
            type="checkbox"
            checked={all}
            onChange={(e) => A(e.target.checked)}
          />
          本工作台所有会话
        </label>
      </div>
      {error && <p role="alert">{error}</p>}
      {data && (
        <>
          <div className="usage-grid">
            {[
              ["requests", "请求"],
              ["input_tokens", "输入 token"],
              ["output_tokens", "输出 token"],
              ["cache_read_input_tokens", "缓存读取"],
              ["cache_creation_input_tokens", "缓存写入"],
              ["webSearch", "搜索"],
              ["webFetch", "抓取"],
              ["advisorCalls", "顾问调用"],
            ].map(([key, label]) => (
              <div className="card" key={key}>
                <span>{label}</span>
                <strong>{n(data.total[key])}</strong>
              </div>
            ))}
          </div>
          <p>
            Token 费用估算：<b>${data.total.estimatedTokenUsd.toFixed(5)}</b>
            {data.total.unpricedRequests > 0 &&
              ` · ${data.total.unpricedRequests} 次请求缺少价格`}
          </p>
          <p className="muted">
            只统计本工作台收到的 API
            用量。搜索、执行容器等额外费用不包含在估算中；以账单为准。
          </p>
          <details open>
            <summary>速率限制余量</summary>
            {Object.keys(data.rateLimits).length ? (
              <>
                <p className="muted">
                  最近响应快照 · {new Date(data.rateLimitsAt).toLocaleString()}{" "}
                  · 不是账户余额
                </p>
                <dl>
                  {Object.entries(data.rateLimits).map(([k, v]) => (
                    <React.Fragment key={k}>
                      <dt>{k.replace(/^anthropic-/, "")}</dt>
                      <dd>{v}</dd>
                    </React.Fragment>
                  ))}
                </dl>
              </>
            ) : (
              <p>尚未收到速率限制响应头。</p>
            )}
          </details>
          <p>
            账户余额：Messages API 未提供。
            <a href={data.balance.url} target="_blank" rel="noreferrer">
              打开官方账单
            </a>
          </p>
          <details>
            <summary>最近请求</summary>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>模型 / 速度</th>
                    <th>输入 / 输出</th>
                    <th>缓存读 / 写</th>
                    <th>Token 估算</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recent.map((r) => (
                    <tr key={r.id}>
                      <td>{new Date(r.timestamp).toLocaleTimeString()}</td>
                      <td>
                        {r.model}
                        <br />
                        {r.speed === "not_reported"
                          ? "未返回速度标记"
                          : r.speed}
                      </td>
                      <td>
                        {n(r.input_tokens)} / {n(r.output_tokens)}
                      </td>
                      <td>
                        {n(r.cache_read_input_tokens)} /{" "}
                        {n(r.cache_creation_input_tokens)}
                      </td>
                      <td>
                        {r.estimatedTokenUsd === null
                          ? "未知"
                          : "$" + r.estimatedTokenUsd.toFixed(5)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </section>
  );
}
