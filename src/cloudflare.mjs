import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { writePrivate, privateDir } from "./config.mjs";
import { accessProof } from "./access.mjs";
import { Agent, fetch as operatorFetch } from "undici";
const managementDispatcher = new Agent();
const managementFetch = (url, options) =>
  operatorFetch(url, { ...options, dispatcher: managementDispatcher });

export class Cloudflare {
  constructor(token, { fetcher = managementFetch } = {}) {
    this.token = token;
    this.fetcher = fetcher;
  }
  async call(method, route, body) {
    let r;
    try {
      r = await this.fetcher("https://api.cloudflare.com/client/v4" + route, {
        method,
        headers: {
          Authorization: "Bearer " + this.token,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
        redirect: "error",
      });
    } catch {
      throw new Error(
        method === "GET"
          ? "cloudflare_unreachable"
          : "cloudflare_outcome_unknown",
      );
    }
    let data;
    try {
      data = await r.json();
    } catch {
      throw new Error(
        method === "GET"
          ? "cloudflare_invalid_response"
          : "cloudflare_outcome_unknown",
      );
    }
    if (!r.ok || !data.success) throw new Error("cloudflare_http_" + r.status);
    return data;
  }
  async list(route) {
    const all = [];
    for (let page = 1; page <= 100; page++) {
      const r = await this.call(
        "GET",
        route + (route.includes("?") ? "&" : "?") + "per_page=100&page=" + page,
      );
      all.push(...r.result);
      if (!r.result_info || page >= (r.result_info.total_pages || 1))
        return all;
    }
    throw new Error("cloudflare_list_too_large");
  }
}
export function readEnrollment(file) {
  const c = JSON.parse(fs.readFileSync(file, "utf8"));
  if (
    !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(c.zone || "") ||
    !Number.isInteger(c.port) ||
    c.port < 1024 ||
    c.port > 65535
  )
    throw new Error("invalid_zone_or_port");
  if (
    !Array.isArray(c.allowedEmails) ||
    !c.allowedEmails.length ||
    c.allowedEmails.length > 100 ||
    c.allowedEmails.some(
      (e) => typeof e !== "string" || !/^\S+@[^@\s]+\.[^@\s]+$/.test(e),
    )
  )
    throw new Error("explicit_login_emails_required");
  c.allowedEmails = [
    ...new Set(c.allowedEmails.map((x) => x.toLowerCase())),
  ].sort();
  c.prefix = (c.prefix || "console").replaceAll("_", "-");
  if (!/^[a-z][a-z0-9-]{0,35}[a-z0-9]$/.test(c.prefix))
    throw new Error("invalid_hostname_prefix");
  if (typeof c.tokenFile !== "string") throw new Error("token_file_required");
  const tokenFile = path.resolve(path.dirname(file), c.tokenFile),
    st = fs.lstatSync(tokenFile);
  if (!st.isFile() || st.isSymbolicLink() || st.size > 16384)
    throw new Error("invalid_token_file");
  if (process.platform !== "win32" && st.mode & 0o077)
    throw new Error("token_file_requires_mode_600");
  return { config: c, token: fs.readFileSync(tokenFile, "utf8").trim() };
}
export class Enrollment {
  constructor(api, root) {
    this.api = api;
    this.root = privateDir(path.join(root, "cloudflare"));
    this.profile = root;
    this.file = path.join(this.root, "receipt.json");
  }
  read() {
    if (!fs.existsSync(this.file)) throw new Error("cloudflare_plan_required");
    return JSON.parse(fs.readFileSync(this.file, "utf8"));
  }
  save(r) {
    writePrivate(this.file, r);
    return r;
  }
  async plan(c) {
    if (fs.existsSync(this.file))
      throw new Error("existing_enrollment_use_status_or_resume");
    const zones = await this.api.list(
      "/zones?name=" + encodeURIComponent(c.zone),
    );
    if (zones.length !== 1 || zones[0].name !== c.zone)
      throw new Error("exact_zone_not_available");
    const zone = zones[0],
      account = zone.account.id,
      base = "/accounts/" + account;
    const [org, idps, apps] = await Promise.all([
      this.api.call("GET", base + "/access/organizations"),
      this.api.list(base + "/access/identity_providers"),
      this.api.list(base + "/access/apps"),
    ]);
    if (
      !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(org.result.auth_domain || "")
    )
      throw new Error("configure_zero_trust_team_first");
    if (!idps.length) throw new Error("configure_access_login_method_first");
    const deployment = crypto.randomBytes(6).toString("hex"),
      hostname = (c.prefix || "console") + "-" + deployment + "." + c.zone;
    const records = await this.api.list(
      "/zones/" + zone.id + "/dns_records?name=" + hostname,
    );
    if (
      records.length ||
      apps.some(
        (a) =>
          a.domain === hostname ||
          a.destinations?.some((d) => d.uri === hostname),
      )
    )
      throw new Error("hostname_already_used");
    return this.save({
      format: 1,
      stage: "planned",
      deployment,
      name: "starport-" + deployment,
      hostname,
      zone: zone.id,
      account,
      issuer: "https://" + org.result.auth_domain,
      allowedEmails: c.allowedEmails,
      port: c.port,
      resources: {},
      createdAt: new Date().toISOString(),
    });
  }
  async create(r, key, route, body) {
    if (r.resources[key]) return r.resources[key];
    if (r.pending) throw new Error("cloudflare_outcome_unknown_run_status");
    r.pending = { key, route, body };
    this.save(r);
    // Never retry a creation with an unknown outcome. status reconciles by unique name.
    const result = (await this.api.call("POST", route, body)).result;
    r.resources[key] = result;
    r.pending = null;
    this.save(r);
    return result;
  }
  async status() {
    const r = this.read();
    if (r.pending) {
      const p = r.pending,
        rows = await this.api.list(
          p.route + (p.key === "dns" ? "?name=" + r.hostname : ""),
        );
      const matches = rows.filter(
        (x) =>
          x.name === p.body.name &&
          (p.key !== "dns" || x.content === p.body.content),
      );
      if (matches.length === 1) {
        r.resources[p.key] = matches[0];
        r.pending = null;
        this.save(r);
      }
    }
    return r;
  }
  async apply() {
    const r = await this.status();
    if (r.pending) throw new Error("cloudflare_outcome_unknown_do_not_repeat");
    if (r.stage === "removed") throw new Error("enrollment_removed");
    const b = "/accounts/" + r.account;
    const policy = await this.create(r, "policy", b + "/access/policies", {
      name: r.name,
      decision: "allow",
      include: r.allowedEmails.map((email) => ({ email: { email } })),
      require: [],
      exclude: [],
      session_duration: "12h",
    });
    const app = await this.create(r, "app", b + "/access/apps", {
      name: r.name,
      type: "self_hosted",
      domain: r.hostname,
      session_duration: "12h",
      policies: [{ id: policy.id, precedence: 1 }],
      app_launcher_visible: false,
      http_only_cookie_attribute: true,
    });
    const live = (await this.api.call("GET", b + "/access/apps/" + app.id))
      .result;
    if (live.domain !== r.hostname || live.type !== "self_hosted" || !live.aud)
      throw new Error("access_application_mismatch");
    const policies = await this.api.list(
      b + "/access/apps/" + app.id + "/policies",
    );
    const emails = (x) =>
      (x.include || []).map((i) => i.email?.email?.toLowerCase()).sort();
    if (
      policies.length !== 1 ||
      policies[0].id !== policy.id ||
      policies[0].decision !== "allow" ||
      JSON.stringify(emails(policies[0])) !== JSON.stringify(r.allowedEmails) ||
      policies[0].require?.length ||
      policies[0].exclude?.length
    )
      throw new Error("access_policy_mismatch");
    r.resources.app = live;
    const access = {
      mode: "cloudflare",
      issuer: r.issuer,
      audience: live.aud,
      hostname: r.hostname,
      allowedEmails: r.allowedEmails,
    };
    const af = path.join(this.profile, "access.json");
    if (
      fs.existsSync(af) &&
      JSON.parse(fs.readFileSync(af, "utf8")).audience !== live.aud
    )
      throw new Error("profile_has_another_access_application");
    writePrivate(af, access);
    r.stage = "access_ready";
    this.save(r);
    let probe;
    try {
      probe = await managementFetch(
        "http://127.0.0.1:" + r.port + "/api/bootstrap",
        { signal: AbortSignal.timeout(3000), redirect: "error" },
      );
    } catch {
      throw new Error("start_panel_on_configured_port_then_resume");
    }
    if (
      probe.status !== 401 ||
      probe.headers.get("x-starport-access-proof") !== accessProof(access)
    )
      throw new Error("origin_access_verification_failed");
    const tunnel = await this.create(r, "tunnel", b + "/cfd_tunnel", {
      name: r.name,
      config_src: "cloudflare",
    });
    await this.api.call(
      "PUT",
      b + "/cfd_tunnel/" + tunnel.id + "/configurations",
      {
        config: {
          ingress: [
            { hostname: r.hostname, service: "http://127.0.0.1:" + r.port },
            { service: "http_status:404" },
          ],
        },
      },
    );
    const token = (
      await this.api.call("GET", b + "/cfd_tunnel/" + tunnel.id + "/token")
    ).result;
    const tokenFile = path.join(this.root, "tunnel-token");
    fs.writeFileSync(tokenFile, token, { mode: 0o600 });
    if (process.platform !== "win32") fs.chmodSync(tokenFile, 0o600);
    await this.create(r, "dns", "/zones/" + r.zone + "/dns_records", {
      name: r.hostname,
      type: "CNAME",
      content: tunnel.id + ".cfargotunnel.com",
      proxied: true,
      ttl: 1,
    });
    r.stage = "configured";
    this.save(r);
    return r;
  }
  async rollback() {
    const r = await this.status();
    if (r.pending)
      throw new Error("unresolved_creation_inspect_before_rollback");
    const b = "/accounts/" + r.account;
    for (const [key, base] of [
      ["dns", "/zones/" + r.zone + "/dns_records"],
      ["tunnel", b + "/cfd_tunnel"],
      ["app", b + "/access/apps"],
      ["policy", b + "/access/policies"],
    ]) {
      const owned = r.resources[key];
      if (!owned || owned.removed) continue;
      let current;
      try {
        current = (await this.api.call("GET", base + "/" + owned.id)).result;
      } catch (e) {
        if (e.message === "cloudflare_http_404") {
          owned.removed = true;
          this.save(r);
          continue;
        }
        throw e;
      }
      if (
        current.name !== (key === "dns" ? r.hostname : r.name) ||
        (key === "dns" &&
          current.content !== r.resources.tunnel.id + ".cfargotunnel.com") ||
        (key === "app" && current.domain !== r.hostname)
      )
        throw new Error("resource_changed_do_not_delete");
      await this.api.call("DELETE", base + "/" + owned.id);
      owned.removed = true;
      this.save(r);
    }
    // Keep the origin fail-closed after removing public ingress; local reset is explicit.
    r.stage = "removed";
    this.save(r);
    return r;
  }
}
