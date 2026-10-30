import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { id, writePrivate } from "./config.mjs";

export const FEATURE_DEFAULTS = Object.freeze({
  webSearch: false,
  webFetch: false,
  codeExecution: false,
  advisor: false,
  advisorModel: "claude-opus-5-5",
  fast: false,
  cache: "5m",
  maxUses: 5,
  skills: [],
  mcp: [],
  plugins: [],
});
export function features(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid_features");
  const out = { ...FEATURE_DEFAULTS };
  for (const key of [
    "webSearch",
    "webFetch",
    "codeExecution",
    "advisor",
    "fast",
  ])
    if (key in value) {
      if (typeof value[key] !== "boolean") throw new Error("invalid_features");
      out[key] = value[key];
    }
  if (value.cache !== undefined) {
    if (!["off", "5m", "1h"].includes(value.cache))
      throw new Error("invalid_cache_mode");
    out.cache = value.cache;
  }
  if (value.advisorModel !== undefined) {
    if (!/^claude-[a-z0-9-]{3,90}$/.test(value.advisorModel))
      throw new Error("invalid_advisor_model");
    out.advisorModel = value.advisorModel;
  }
  if (value.maxUses !== undefined) {
    if (
      !Number.isInteger(value.maxUses) ||
      value.maxUses < 1 ||
      value.maxUses > 10
    )
      throw new Error("invalid_tool_limit");
    out.maxUses = value.maxUses;
  }
  for (const key of ["skills", "mcp", "plugins"]) {
    if (value[key] !== undefined) {
      if (!Array.isArray(value[key]) || value[key].length > 20)
        throw new Error("invalid_addon_selection");
      out[key] = [...new Set(value[key].map(id))];
    }
  }
  return out;
}
function text(value, max, error) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    Buffer.byteLength(value) > max ||
    value.includes("\0")
  )
    throw new Error(error);
  return value.trim();
}
function publicUrl(value) {
  let u;
  try {
    u = new URL(value);
  } catch {
    throw new Error("mcp_public_https_required");
  }
  const h = u.hostname.toLowerCase();
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.hash ||
    u.port ||
    net.isIP(h) ||
    h.startsWith("[") ||
    !h.includes(".") ||
    /(?:^|\.)(localhost|local|internal|lan|home|test|invalid)$/.test(h) ||
    h.length > 253
  )
    throw new Error("mcp_public_https_required");
  // The operator never resolves or contacts this URL. The Anthropic connector does.
  return u.href;
}
export class Addons {
  constructor(root) {
    this.file = path.join(root, "addons.json");
  }
  read() {
    return fs.existsSync(this.file)
      ? JSON.parse(fs.readFileSync(this.file, "utf8"))
      : { skills: [], mcp: [], plugins: [] };
  }
  list() {
    const d = this.read();
    return {
      ...d,
      mcp: d.mcp.map(({ token, ...x }) => ({
        ...x,
        tokenConfigured: Boolean(token),
      })),
    };
  }
  save(kind, input) {
    if (!["skills", "mcp", "plugins"].includes(kind))
      throw new Error("invalid_addon_kind");
    const data = this.read(),
      key = id(input.id),
      old = data[kind].find((x) => x.id === key);
    const item = {
      id: key,
      label: text(input.label, 120, "invalid_addon_label"),
      enabled: input.enabled === true,
    };
    if (kind === "skills")
      item.content = text(input.content, 32000, "invalid_skill_content");
    if (kind === "mcp") {
      item.url = publicUrl(text(input.url, 2048, "invalid_mcp_url"));
      const token = input.clearToken ? "" : input.token || old?.token || "";
      if (
        typeof token !== "string" ||
        token.length > 8192 ||
        /[\r\n\0]/.test(token)
      )
        throw new Error("invalid_mcp_token");
      item.token = token;
      if (
        !Array.isArray(input.tools) ||
        input.tools.length < 1 ||
        input.tools.length > 100 ||
        input.tools.some((n) => !/^[a-zA-Z0-9_.:-]{1,100}$/.test(n))
      )
        throw new Error("mcp_tool_allowlist_required");
      item.tools = [...new Set(input.tools)];
    }
    if (kind === "plugins") {
      // Declarative bundles only. Never install packages or execute host hooks.
      if (
        Object.keys(input).some(
          (k) =>
            ![
              "id",
              "label",
              "enabled",
              "description",
              "skills",
              "mcp",
            ].includes(k),
        )
      )
        throw new Error("plugin_declarative_fields_only");
      item.description = text(
        input.description,
        1000,
        "invalid_plugin_description",
      );
      for (const k of ["skills", "mcp"]) {
        if (!Array.isArray(input[k]) || input[k].length > 20)
          throw new Error("invalid_plugin_members");
        item[k] = [...new Set(input[k].map(id))];
        if (item[k].some((n) => !data[k].some((x) => x.id === n)))
          throw new Error("plugin_member_not_found");
      }
    }
    data[kind] = [...data[kind].filter((x) => x.id !== key), item];
    if (data[kind].length > 100) throw new Error("addon_limit");
    writePrivate(this.file, data);
    return this.list();
  }
  remove(kind, key) {
    const data = this.read();
    if (!["skills", "mcp", "plugins"].includes(kind))
      throw new Error("invalid_addon_kind");
    data[kind] = data[kind].filter((x) => x.id !== id(key));
    for (const p of data.plugins)
      if (p[kind]) p[kind] = p[kind].filter((x) => x !== key);
    writePrivate(this.file, data);
    return this.list();
  }
  resolve(selection) {
    const f = features(selection),
      data = this.read();
    const chosen = (k) => new Set(f[k]);
    const skills = chosen("skills"),
      mcp = chosen("mcp");
    for (const key of f.plugins) {
      const p = data.plugins.find((x) => x.id === key && x.enabled);
      if (!p) throw new Error("addon_not_enabled");
      p.skills.forEach((x) => skills.add(x));
      p.mcp.forEach((x) => mcp.add(x));
    }
    const select = (k, names) =>
      [...names].map((n) => {
        const item = data[k].find((x) => x.id === n && x.enabled);
        if (!item) throw new Error("addon_not_enabled");
        return item;
      });
    const selectedSkills = select("skills", skills);
    if (
      selectedSkills.reduce((n, s) => n + Buffer.byteLength(s.content), 0) >
      128000
    )
      throw new Error("skill_context_limit");
    return { skills: selectedSkills, mcp: select("mcp", mcp) };
  }
}
