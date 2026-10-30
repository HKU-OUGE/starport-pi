import fs from "node:fs";
import path from "node:path";
import { writePrivate } from "./config.mjs";

const number = (x) => (Number.isFinite(x) && x >= 0 ? x : 0);
const fields = [
  "input_tokens",
  "output_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
];
function tokens(u = {}) {
  return Object.fromEntries(fields.map((k) => [k, number(u[k])]));
}
export function rates(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers))
    if (
      /^anthropic-(?:ratelimit|fast)-(?:requests|tokens|input-tokens|output-tokens)-(?:limit|remaining|reset)$/.test(
        k,
      ) &&
      String(v).length < 100
    )
      out[k] = String(v);
  return out;
}
function estimate(model, u, speed, cache, cost) {
  if (speed === "fast") {
    if (model === "claude-opus-5-5")
      cost = { input: 8, output: 40, cacheRead: 0.4 };
    else if (["claude-opus-5", "claude-opus-4-8"].includes(model))
      cost = { input: 10, output: 50, cacheRead: 1 };
    else return null;
  }
  if (!cost) return null;
  if (model === "claude-haiku-5-5") {
    const iterations = (u.iterations || []).filter((x) => x.type === "message");
    if (iterations.length)
      return iterations.reduce(
        (n, x) => n + estimate(model, x, speed, cache, cost),
        0,
      );
    if (
      number(u.input_tokens) +
        number(u.cache_read_input_tokens) +
        number(u.cache_creation_input_tokens) >
      100000
    )
      cost = { input: 0.5, output: 2.5, cacheRead: 0.05 };
  }
  const split = u.cache_creation;
  const write = split
    ? number(split.ephemeral_5m_input_tokens) * 1.25 +
      number(split.ephemeral_1h_input_tokens) * 2
    : number(u.cache_creation_input_tokens) * (cache === "1h" ? 2 : 1.25);
  return (
    (number(u.input_tokens) * cost.input +
      number(u.output_tokens) * cost.output +
      number(u.cache_read_input_tokens) * (cost.cacheRead ?? cost.input * 0.1) +
      write * cost.input) /
    1e6
  );
}
export function usageRecord({
  id,
  model,
  usage,
  headers,
  headersAt = Date.now(),
  cache,
  session,
  stopReason,
  requestedSpeed = "standard",
  costForModel = () => null,
}) {
  const advisor = (usage.iterations || [])
    .filter((x) => x.type === "advisor_message")
    .map((x) => ({
      model: x.model,
      ...tokens(x),
      estimatedUsd: estimate(
        x.model,
        x,
        "standard",
        cache,
        costForModel(x.model),
      ),
    }));
  const main =
    !usage.speed && requestedSpeed === "fast"
      ? null
      : estimate(model, usage, usage.speed, cache, costForModel(model));
  const totals = tokens(usage);
  for (const a of advisor) for (const k of fields) totals[k] += a[k];
  return {
    id,
    session,
    model,
    timestamp: Date.now(),
    stopReason,
    requestedSpeed,
    speed: usage.speed || "not_reported",
    ...totals,
    advisor,
    webSearch: number(usage.server_tool_use?.web_search_requests),
    webFetch: number(usage.server_tool_use?.web_fetch_requests),
    estimatedTokenUsd:
      main === null || advisor.some((x) => x.estimatedUsd === null)
        ? null
        : main + advisor.reduce((n, x) => n + x.estimatedUsd, 0),
    rateLimits: rates(headers),
    rateLimitsAt: headersAt,
    otherChargesExcluded: true,
  };
}
export class UsageStore {
  constructor(root) {
    this.file = path.join(root, "usage.json");
  }
  read() {
    return fs.existsSync(this.file)
      ? JSON.parse(fs.readFileSync(this.file, "utf8"))
      : {};
  }
  record(row) {
    const d = this.read();
    if (!d[row.id]) {
      d[row.id] = row;
      writePrivate(this.file, d);
    }
  }
  snapshot(session) {
    const all = Object.values(this.read())
      .filter((x) => !session || x.session === session)
      .sort((a, b) => b.timestamp - a.timestamp);
    const total = {
      requests: all.length,
      estimatedTokenUsd: 0,
      unpricedRequests: 0,
      webSearch: 0,
      webFetch: 0,
      advisorCalls: 0,
      ...tokens(),
    };
    for (const r of all) {
      for (const k of [...fields, "webSearch", "webFetch"])
        total[k] += number(r[k]);
      total.advisorCalls += r.advisor.length;
      if (r.estimatedTokenUsd === null) total.unpricedRequests++;
      else total.estimatedTokenUsd += r.estimatedTokenUsd;
    }
    return {
      total,
      recent: all.slice(0, 50),
      rateLimits:
        all.find((x) => Object.keys(x.rateLimits).length)?.rateLimits || {},
      rateLimitsAt:
        all.find((x) => Object.keys(x.rateLimits).length)?.rateLimitsAt || null,
      balance: {
        available: false,
        reason: "billing_balance_not_provided_by_messages_api",
        url: "https://platform.claude.com/settings/billing",
      },
      scope: "this_installation",
      otherChargesExcluded: true,
    };
  }
}
