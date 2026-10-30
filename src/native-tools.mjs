import crypto from "node:crypto";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { features } from "./addons.mjs";
import { usageRecord } from "./usage.mjs";

const copy = (x) => structuredClone(x);
const zero = () => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});
export function providerError(message = "") {
  if (/^[a-z0-9_]{1,100}$/.test(message)) return message;
  for (const [pattern, code] of [
    [
      /credit balance|insufficient.credit/i,
      "anthropic_credit_balance_insufficient",
    ],
    [/rate.limit|too.many.requests|\b429\b/i, "anthropic_rate_limit_exceeded"],
    [/authentication|invalid.x.api.key|\b401\b/i, "anthropic_api_key_rejected"],
    [/fast.mode|speed.*fast/i, "anthropic_fast_mode_not_available"],
    [
      /not.support.*tool|tool.*not.support|invalid_request_error/i,
      "anthropic_request_options_not_supported",
    ],
    [
      /connection|network|fetch failed|timed?.out|timeout/i,
      "anthropic_proxy_or_network_unavailable",
    ],
  ])
    if (pattern.test(message)) return code;
  return "anthropic_request_failed_check_model_tools_and_account";
}
const mergeUsage = (a, b) => ({
  ...a,
  ...b,
  server_tool_use: { ...a.server_tool_use, ...b.server_tool_use },
});
export function nativeDefinition(value, addons, model) {
  const f = features(value),
    tools = [],
    betas = [];
  if (f.webSearch)
    tools.push({
      type: "web_search_20250305",
      name: "web_search",
      max_uses: f.maxUses,
    });
  if (f.webFetch)
    tools.push({
      type: "web_fetch_20250910",
      name: "web_fetch",
      max_uses: f.maxUses,
      max_content_tokens: 20000,
      citations: { enabled: true },
    });
  if (f.codeExecution)
    tools.push({ type: "code_execution_20260521", name: "code_execution" });
  if (f.advisor) {
    tools.push({
      type: "advisor_20260301",
      name: "advisor",
      model: f.advisorModel,
      max_uses: Math.min(3, f.maxUses),
      max_tokens: 4096,
    });
    betas.push("advisor-tool-2026-03-01");
  }
  if (f.fast && model !== "claude-opus-5-5") {
    if (!["claude-opus-5", "claude-opus-4-8"].includes(model))
      throw new Error("fast_mode_not_supported_by_selected_model");
    betas.push("fast-mode-2026-02-01");
  }
  const servers = (addons.mcp || []).map((m) => {
    tools.push({
      type: "mcp_toolset",
      mcp_server_name: m.id,
      default_config: { enabled: false },
      configs: Object.fromEntries(m.tools.map((n) => [n, { enabled: true }])),
    });
    return {
      type: "url",
      name: m.id,
      url: m.url,
      ...(m.token ? { authorization_token: m.token } : {}),
    };
  });
  if (servers.length) betas.push("mcp-client-2025-11-20");
  return { tools, betas, servers, f };
}
export class NativeCollector {
  constructor() {
    this.blocks = [];
    this.json = new Map();
    this.usage = {};
    this.stop = null;
  }
  event(e) {
    if (e.type === "message_start") {
      this.id = e.message.id;
      this.usage = mergeUsage(this.usage, e.message.usage || {});
      this.container = e.message.container;
    }
    if (e.type === "content_block_start")
      this.blocks[e.index] = copy(e.content_block);
    if (e.type === "content_block_delta") {
      const b = this.blocks[e.index],
        d = e.delta;
      if (!b) return;
      if (d.type === "text_delta") b.text = (b.text || "") + d.text;
      if (d.type === "thinking_delta")
        b.thinking = (b.thinking || "") + d.thinking;
      if (d.type === "signature_delta")
        b.signature = (b.signature || "") + d.signature;
      if (d.type === "input_json_delta")
        this.json.set(e.index, (this.json.get(e.index) || "") + d.partial_json);
      if (d.type === "citations_delta")
        (b.citations ||= []).push(copy(d.citation));
    }
    if (e.type === "content_block_stop" && this.json.has(e.index)) {
      try {
        const input = this.json.get(e.index);
        // A parameterless tool may emit an empty delta instead of "{}".
        // Keep its initial input; malformed non-empty JSON must still fail.
        if (input.trim()) this.blocks[e.index].input = JSON.parse(input);
      } catch {
        throw new Error("invalid_native_tool_stream");
      }
    }
    if (e.type === "message_delta") {
      this.usage = mergeUsage(this.usage, e.usage || {});
      this.stop = e.delta?.stop_reason || this.stop;
      this.container = e.delta?.container || this.container;
    }
  }
}
export function nativeView(blocks = []) {
  const tools = [],
    sources = [],
    files = [];
  const source = (c) => {
    if (
      typeof c?.url === "string" &&
      /^https?:\/\//.test(c.url) &&
      !sources.some((s) => s.url === c.url)
    )
      sources.push({ url: c.url, title: c.title || c.document_title || c.url });
  };
  function fileItems(x) {
    if (Array.isArray(x)) return x.forEach(fileItems);
    if (!x || typeof x !== "object") return;
    if (
      /^file_[a-zA-Z0-9_-]+$/.test(x.file_id || "") &&
      !files.includes(x.file_id)
    )
      files.push(x.file_id);
    if (x.content) fileItems(x.content);
  }
  for (const b of blocks) {
    if (["server_tool_use", "mcp_tool_use"].includes(b.type))
      tools.push({
        id: b.id,
        name: b.name,
        server: b.server_name,
        input: b.input,
        status: "running",
      });
    if (b.type.endsWith("tool_result")) {
      const t = tools.find((x) => x.id === b.tool_use_id);
      if (t) {
        t.status = b.is_error || b.content?.error_code ? "error" : "complete";
        t.error = b.content?.error_code;
        t.result = b.content?.encrypted_content
          ? { redacted: true }
          : b.content;
      }
      if (
        [
          "bash_code_execution_tool_result",
          "code_execution_tool_result",
          "text_editor_code_execution_tool_result",
        ].includes(b.type)
      )
        fileItems(b.content);
    }
    if (Array.isArray(b.citations)) b.citations.forEach(source);
    if (b.type === "web_search_tool_result" && Array.isArray(b.content))
      b.content.forEach(source);
    if (b.type === "web_fetch_tool_result") source(b.content);
  }
  // Opaque search/advisor data is for API replay, never a browser transcript.
  const clean = (x) => {
    if (Array.isArray(x)) return x.slice(0, 50).map(clean);
    if (!x || typeof x !== "object")
      return typeof x === "string" ? x.slice(0, 24000) : x;
    return Object.fromEntries(
      Object.entries(x)
        .filter(
          ([k]) =>
            !["encrypted_content", "signature", "authorization_token"].includes(
              k,
            ),
        )
        .map(([k, v]) => [k, clean(v)]),
    );
  };
  return { tools: clean(tools), sources, files };
}
function clearCache(x) {
  if (Array.isArray(x)) return x.map(clearCache);
  if (x && typeof x === "object")
    return Object.fromEntries(
      Object.entries(x)
        .filter(([k]) => k !== "cache_control")
        .map(([k, v]) => [k, clearCache(v)]),
    );
  return x;
}
function prepareContext(context, model) {
  const raw = new Map();
  const messages = context.messages.map((m) => {
    if (
      m.role !== "assistant" ||
      ["error", "aborted"].includes(m.stopReason) ||
      !m.starportNative?.content?.length
    )
      return m;
    const marker = "STARPORT_REPLAY_" + crypto.randomBytes(24).toString("hex");
    raw.set(
      marker,
      m.starportNative.content.filter(
        (b) =>
          m.model === model.id ||
          !["thinking", "redacted_thinking"].includes(b.type),
      ),
    );
    return { ...m, content: [...m.content, { type: "text", text: marker }] };
  });
  return { context: { ...context, messages }, raw };
}
export function nativeStream(
  base,
  value,
  addons = {},
  {
    onUsage = () => {},
    session,
    attachments,
    onNative = () => {},
    costForModel,
  } = {},
) {
  return (model, context, options = {}) => {
    const output = createAssistantMessageEventStream();
    (async () => {
      let history = context,
        prefix = [],
        rawPrefix = [],
        total = zero(),
        container,
        paused = false;
      let last = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        content: [],
        usage: zero(),
        stopReason: "stop",
      };
      try {
        const definition = nativeDefinition(value, addons, model.id),
          { f } = definition;
        for (let attempt = 0; attempt < 3; attempt++) {
          options.signal?.throwIfAborted();
          const collector = new NativeCollector(),
            prepared = prepareContext(history, model);
          let headers = {},
            headersAt,
            partial = last;
          const stream = await base(model, prepared.context, {
            ...options,
            cacheRetention: "none",
            onPayload: async (payload) => {
              let p = clearCache(
                (await options.onPayload?.(payload, model)) || payload,
              );
              delete p.metadata;
              p.tools = [...(p.tools || []), ...definition.tools];
              p.betas = [...new Set([...(p.betas || []), ...definition.betas])];
              if (definition.servers.length) p.mcp_servers = definition.servers;
              if (f.fast) p.speed = "fast";
              if (f.cache !== "off")
                p.cache_control = {
                  type: "ephemeral",
                  ...(f.cache === "1h" ? { ttl: "1h" } : {}),
                };
              for (const m of p.messages) {
                if (!Array.isArray(m.content)) continue;
                for (const [marker, blocks] of prepared.raw) {
                  if (
                    m.content.some(
                      (b) => b.type === "text" && b.text?.includes(marker),
                    )
                  ) {
                    m.content = copy(blocks);
                    break;
                  }
                }
              }
              for (const blocks of prepared.raw.values()) {
                if (blocks.some((b) => b.type === "advisor_tool_result"))
                  p.betas.push("advisor-tool-2026-03-01");
                if (blocks.some((b) => b.type.startsWith("mcp_")))
                  p.betas.push("mcp-client-2025-11-20");
              }
              p.betas = [...new Set(p.betas)];
              if (attachments)
                p = await attachments.inject(p, {
                  codeExecution: f.codeExecution,
                  signal: options.signal,
                });
              const prior = [...history.messages]
                .reverse()
                .find((m) => m.starportNative?.container)
                ?.starportNative?.container;
              const reuse = container || prior;
              if (
                f.codeExecution &&
                reuse?.id &&
                (!reuse.expires_at ||
                  Date.parse(reuse.expires_at) > Date.now() + 10000)
              )
                p.container = reuse.id;
              return p;
            },
            onResponse: async (r) => {
              headers = r.headers;
              headersAt = Date.now();
              await options.onResponse?.(r, model);
            },
            onProviderStreamEvent: async (e) => {
              collector.event(e);
              await options.onProviderStreamEvent?.(e, model);
              if (
                e.type === "content_block_start" &&
                !["text", "thinking", "redacted_thinking", "tool_use"].includes(
                  e.content_block.type,
                )
              ) {
                const native = nativeView([
                  ...rawPrefix,
                  ...collector.blocks.filter(Boolean),
                ]);
                onNative(native);
                output.push({
                  type: "text_delta",
                  contentIndex: 0,
                  delta: "",
                  partial: {
                    ...copy(partial),
                    content: [...copy(prefix), ...copy(partial.content)],
                    native,
                  },
                });
              }
            },
          });
          for await (const event of stream) {
            if (event.type === "done" || event.type === "error") continue;
            if (event.partial) {
              partial = event.partial;
              output.push({
                ...event,
                partial: {
                  ...copy(partial),
                  content: [...copy(prefix), ...copy(partial.content)],
                  native: nativeView([
                    ...rawPrefix,
                    ...collector.blocks.filter(Boolean),
                  ]),
                },
                ...(Number.isInteger(event.contentIndex)
                  ? { contentIndex: prefix.length + event.contentIndex }
                  : {}),
              });
            } else output.push(event);
          }
          last = await stream.result();
          for (const k of [
            "input",
            "output",
            "cacheRead",
            "cacheWrite",
            "totalTokens",
          ])
            total[k] += last.usage?.[k] || 0;
          for (const k of Object.keys(total.cost))
            total.cost[k] += last.usage?.cost?.[k] || 0;
          container = collector.container || container;
          const blocks = collector.blocks.filter(Boolean);
          if (collector.id)
            onUsage(
              usageRecord({
                id: collector.id,
                model: model.id,
                usage: collector.usage,
                headers,
                headersAt,
                cache: f.cache,
                session,
                stopReason: collector.stop || last.stopReason,
                requestedSpeed: f.fast ? "fast" : "standard",
                costForModel: costForModel || (() => model.cost),
              }),
            );
          prefix.push(...copy(last.content));
          rawPrefix.push(...blocks);
          if (
            last.stopReason === "error" ||
            last.stopReason === "aborted" ||
            collector.stop !== "pause_turn"
          )
            break;
          if (attempt === 2) {
            last.stopReason = "stop";
            paused = true;
            break;
          }
          history = {
            ...history,
            messages: [
              ...history.messages,
              { ...last, starportNative: { content: blocks, container } },
            ],
          };
        }
        last = {
          ...last,
          content: prefix,
          usage: total,
          native: { ...nativeView(rawPrefix), paused },
          starportNative: { content: rawPrefix, container },
        };
        if (last.stopReason === "error")
          last.errorMessage = providerError(last.errorMessage);
      } catch (e) {
        last = {
          ...last,
          content: prefix,
          stopReason: options.signal?.aborted ? "aborted" : "error",
          errorMessage: /^[a-z0-9_]{1,100}$/.test(e.message || "")
            ? e.message
            : "native_request_failed",
        };
      }
      if (["error", "aborted"].includes(last.stopReason))
        output.push({ type: "error", reason: last.stopReason, error: last });
      else
        output.push({ type: "done", reason: last.stopReason, message: last });
      output.end(last);
    })();
    return output;
  };
}
