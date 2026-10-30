import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { promisify } from "node:util";
import {
  load,
  save,
  id,
  privateDir,
  writePrivate,
  validateServer,
} from "./config.mjs";
import { normalizeNode } from "./network.mjs";
const scrypt = promisify(crypto.scrypt);
const limit = 16 * 1024 * 1024;
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
function secretText(file) {
  if (!file || !fs.existsSync(file)) return null;
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || st.size > 65536)
    throw new Error("invalid_export_secret_file");
  return fs.readFileSync(file, "utf8");
}
function credentials(text) {
  const out = {};
  for (const line of (text || "").split("\n")) {
    const m = line.match(
      /^\s*(accesskeyid|accesskeysecret|ststoken)\s*=\s*(['"])(.*?)\2\s*$/,
    );
    if (m) out[m[1]] = m[3];
  }
  return out;
}
function writeSecret(file, text) {
  privateDir(path.dirname(file));
  fs.writeFileSync(file, text, { mode: 0o600 });
  if (process.platform !== "win32") fs.chmodSync(file, 0o600);
}
export function collectProfile(root, { includeSecrets = false } = {}) {
  const c = load(root),
    bundle = {
      format: "starport-pi-profile",
      version: 1,
      createdAt: new Date().toISOString(),
      includesSecrets: includeSecrets,
      preferences: {
        model: c.model,
        effort: c.effort,
        interfaceLanguage: "zh-CN",
      },
      network: { subscriptions: [], selected: c.proxy.selected || null },
      servers: [],
      cloudflare: null,
    };
  for (const s of c.subscriptions) {
    const data = read(path.join(root, "subscriptions", id(s.id) + ".json"));
    bundle.network.subscriptions.push({
      id: s.id,
      label: s.label,
      ...(includeSecrets
        ? {
            nodes: data.nodes.map(normalizeNode),
            hosts: data.hosts || {},
            url: data.url || null,
          }
        : { needsCredentials: true }),
    });
  }
  for (const [name, s] of Object.entries(c.servers)) {
    if (s.mode === "wsl") {
      bundle.localRuntime = { requested: true, budget: s.budget };
      continue;
    }
    const row = {
      name,
      mode: s.mode,
      ...(s.mode === "dsw"
        ? { instanceId: s.instanceId, region: s.region, user: s.user }
        : { host: s.host, port: s.port || 22 }),
      budget: s.budget || { cpus: 4, memoryGiB: 8, gpus: [] },
    };
    if (includeSecrets) {
      row.privateKey = secretText(s.identityFile);
      if (!row.privateKey)
        throw new Error("export_server_private_key_required");
      if (s.mode === "dsw")
        row.credentials = credentials(secretText(s.credentialsFile));
    } else row.needsCredentials = true;
    bundle.servers.push(row);
  }
  const apiFile = path.join(root, "secrets.json");
  if (includeSecrets && fs.existsSync(apiFile))
    bundle.anthropicApiKey = read(apiFile).anthropicApiKey;
  const enrollment = path.join(root, "cloudflare", "enrollment.json");
  if (fs.existsSync(enrollment)) {
    const cf = read(enrollment);
    bundle.cloudflare = {
      zone: cf.zone,
      prefix: cf.prefix || "console",
      allowedEmails: cf.allowedEmails,
    };
    if (includeSecrets)
      bundle.cloudflare.apiToken = secretText(
        path.resolve(path.dirname(enrollment), cf.tokenFile),
      )?.trim();
  }
  // Never migrate Access audiences, tunnel tokens, running PIDs, trusted host files or operator paths.
  return bundle;
}
export async function encryptProfile(bundle, password) {
  if (
    typeof password !== "string" ||
    password.length < 12 ||
    password.length > 1024
  )
    throw new Error("export_password_minimum_twelve_characters");
  const plain = Buffer.from(JSON.stringify(bundle));
  if (plain.length > limit) throw new Error("profile_too_large");
  const salt = crypto.randomBytes(16),
    iv = crypto.randomBytes(12),
    key = await scrypt(password, salt, 32);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from("starport-pi-profile:1"));
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  return {
    format: "starport-pi-profile-encrypted",
    version: 1,
    kdf: "scrypt",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: encrypted.toString("base64"),
  };
}
export async function decodeProfile(value, password) {
  if (!value || JSON.stringify(value).length > limit * 2)
    throw new Error("invalid_profile");
  if (value.format === "starport-pi-profile-encrypted") {
    if (
      value.version !== 1 ||
      value.kdf !== "scrypt" ||
      typeof password !== "string" ||
      password.length > 1024
    )
      throw new Error("invalid_profile_password");
    try {
      const salt = Buffer.from(value.salt, "base64"),
        iv = Buffer.from(value.iv, "base64"),
        tag = Buffer.from(value.tag, "base64");
      if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16) throw 0;
      const key = await scrypt(password, salt, 32),
        decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAAD(Buffer.from("starport-pi-profile:1"));
      decipher.setAuthTag(tag);
      value = JSON.parse(
        Buffer.concat([
          decipher.update(Buffer.from(value.data, "base64")),
          decipher.final(),
        ]).toString("utf8"),
      );
    } catch {
      throw new Error("profile_password_or_integrity_failed");
    }
  }
  if (
    value.format !== "starport-pi-profile" ||
    value.version !== 1 ||
    !Array.isArray(value.servers) ||
    value.servers.length > 32 ||
    !Array.isArray(value.network?.subscriptions) ||
    value.network.subscriptions.length > 32
  )
    throw new Error("invalid_profile");
  return value;
}
export function profileSummary(b) {
  return {
    model: b.preferences?.model,
    servers: b.servers.map((s) => ({
      name: s.name,
      mode: s.mode,
      budget: s.budget,
    })),
    subscriptions: b.network.subscriptions.length,
    includesSecrets: Boolean(b.includesSecrets),
    apiKeyIncluded: Boolean(b.anthropicApiKey),
    cloudflareIncluded: Boolean(b.cloudflare),
    cloudflareTokenIncluded: Boolean(b.cloudflare?.apiToken),
    localRuntimeRequested: Boolean(b.localRuntime?.requested),
  };
}
export async function exportProfile(
  root,
  { includeSecrets = false, password } = {},
) {
  const b = collectProfile(root, { includeSecrets });
  return includeSecrets ? encryptProfile(b, password) : b;
}
export async function importProfile(root, value, password) {
  const b = await decodeProfile(value, password),
    c = load(root);
  if (
    c.subscriptions.length ||
    Object.keys(c.servers).length ||
    fs.existsSync(path.join(root, "secrets.json")) ||
    fs.existsSync(path.join(root, "cloudflare", "receipt.json")) ||
    fs.existsSync(path.join(root, "cloudflare", "enrollment.json"))
  )
    throw new Error("import_requires_empty_profile");
  if (
    !/^claude-[a-z0-9.-]{1,80}$/.test(b.preferences?.model || "") ||
    !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
      b.preferences?.effort,
    )
  )
    throw new Error("invalid_profile_model");
  const namespace = privateDir(
      path.join(root, "imports", crypto.randomBytes(12).toString("hex")),
    ),
    servers = Object.create(null),
    subscriptions = [],
    created = [];
  const put = (file, value, text = false) => {
    if (fs.existsSync(file)) throw new Error("import_destination_exists");
    created.push(file);
    text ? writeSecret(file, value) : writePrivate(file, value);
  };
  try {
    for (const s of b.servers) {
      const name = id(s.name);
      if (Object.hasOwn(servers, name)) throw new Error("duplicate_server");
      if (
        !s.privateKey ||
        typeof s.privateKey !== "string" ||
        s.privateKey.length > 65536 ||
        !/^-----BEGIN (OPENSSH |RSA |EC |ENCRYPTED )?PRIVATE KEY-----/.test(
          s.privateKey.trim(),
        )
      )
        throw new Error("import_server_private_key_missing");
      const dir = privateDir(path.join(namespace, name)),
        identityFile = path.join(dir, "identity");
      let server = {
        mode: s.mode,
        identityFile,
        initialized: false,
        budget: s.budget,
      };
      if (s.mode === "dsw") {
        const cred = s.credentials;
        if (
          !cred?.accesskeyid ||
          !cred?.accesskeysecret ||
          Object.values(cred).some(
            (x) =>
              typeof x !== "string" ||
              /[\r\n\x00']/.test(x) ||
              x.length > 16384,
          )
        )
          throw new Error("invalid_import_credentials");
        server = {
          ...server,
          instanceId: s.instanceId,
          region: s.region,
          user: s.user || "root",
          proxyClient: path.join(
            root,
            "tools",
            "proxyclient" + (process.platform === "win32" ? ".exe" : ""),
          ),
          credentialsFile: path.join(dir, "proxyclient-config"),
        };
        validateServer(server);
        writeSecret(
          server.credentialsFile,
          `accesskeyid = '${cred.accesskeyid}'\naccesskeysecret = '${cred.accesskeysecret}'\nregionid = '${s.region}'\nststoken = '${cred.ststoken || ""}'\n`,
        );
      } else if (s.mode === "ssh") {
        server = { ...server, host: s.host, port: s.port || 22 };
        validateServer(server);
      } else throw new Error("unsupported_import_server");
      const budget = server.budget;
      if (
        !budget ||
        !Number.isInteger(budget.cpus) ||
        budget.cpus < 1 ||
        budget.cpus > 512 ||
        !Number.isInteger(budget.memoryGiB) ||
        budget.memoryGiB < 2 ||
        budget.memoryGiB > 4096 ||
        !Array.isArray(budget.gpus) ||
        budget.gpus.some((i) => !Number.isInteger(i) || i < 0 || i > 63)
      )
        throw new Error("invalid_import_budget");
      writeSecret(identityFile, s.privateKey.trim() + "\n");
      servers[name] = server;
    }
    const nodeFiles = [];
    for (const s of b.network.subscriptions) {
      const sid = id(s.id);
      if (subscriptions.some((x) => x.id === sid))
        throw new Error("duplicate_subscription");
      if (!Array.isArray(s.nodes) || !s.nodes.length || s.nodes.length > 5000)
        throw new Error("import_subscription_credentials_missing");
      const nodes = s.nodes.map(normalizeNode);
      if (
        s.url &&
        (typeof s.url !== "string" ||
          !s.url.startsWith("https://") ||
          s.url.length > 8192)
      )
        throw new Error("invalid_import_subscription_url");
      if (
        s.hosts &&
        (typeof s.hosts !== "object" ||
          Array.isArray(s.hosts) ||
          Object.entries(s.hosts).some(
            ([k, v]) =>
              !/^[a-zA-Z0-9.-]{1,253}$/.test(k) ||
              typeof v !== "string" ||
              !/^[a-zA-Z0-9.:[\]-]{1,253}$/.test(v),
          ))
      )
        throw new Error("invalid_import_hosts");
      subscriptions.push({
        id: sid,
        label: String(s.label || sid).slice(0, 80),
      });
      nodeFiles.push([
        sid,
        { nodes, hosts: s.hosts || {}, url: s.url || null },
      ]);
    }
    if (
      b.anthropicApiKey &&
      (typeof b.anthropicApiKey !== "string" ||
        !b.anthropicApiKey.startsWith("sk-ant-") ||
        b.anthropicApiKey.length > 1024)
    )
      throw new Error("invalid_import_api_key");
    const cf = b.cloudflare;
    if (
      cf &&
      (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(cf.zone || "") ||
        !Array.isArray(cf.allowedEmails) ||
        !cf.allowedEmails.length ||
        cf.allowedEmails.some(
          (e) => typeof e !== "string" || !/^\S+@[^@\s]+\.[^@\s]+$/.test(e),
        ) ||
        !/^[-a-z0-9]{1,36}$/.test(cf.prefix || "console") ||
        (cf.apiToken &&
          (typeof cf.apiToken !== "string" ||
            /[\r\n\x00]/.test(cf.apiToken) ||
            cf.apiToken.length > 16384)))
    )
      throw new Error("invalid_import_cloudflare");
    c.model = b.preferences.model;
    c.effort = b.preferences.effort;
    c.interfaceLanguage = "zh-CN";
    c.servers = servers;
    c.subscriptions = subscriptions;
    const selected = /^(sub-[a-f0-9]{12}):(\d+)$/.exec(
      b.network.selected || "",
    );
    c.proxy.selected =
      selected &&
      nodeFiles.some(
        ([sid, data]) => sid === selected[1] && data.nodes[Number(selected[2])],
      )
        ? b.network.selected
        : null;
    for (const [sid, data] of nodeFiles)
      put(path.join(root, "subscriptions", sid + ".json"), data);
    if (b.anthropicApiKey)
      put(path.join(root, "secrets.json"), {
        anthropicApiKey: b.anthropicApiKey,
      });
    if (cf) {
      const dir = privateDir(path.join(root, "cloudflare"));
      if (cf.apiToken) put(path.join(dir, "api-token"), cf.apiToken, true);
      put(path.join(dir, "enrollment.json"), {
        zone: cf.zone,
        prefix: cf.prefix || "console",
        allowedEmails: cf.allowedEmails,
        port: 18900,
        tokenFile: "api-token",
      });
    }
    save(c, root);
    return {
      ...profileSummary(b),
      imported: true,
      serversRequireVerification: true,
      cloudflareRequiresNewEnrollment: Boolean(cf),
    };
  } catch (e) {
    for (const file of created) {
      fs.rmSync(file, { force: true });
      fs.rmSync(file + ".next", { force: true });
    }
    fs.rmSync(namespace, { recursive: true, force: true });
    throw e;
  }
}

export async function updateUnverifiedConnections(root, value, password) {
  const b = await decodeProfile(value, password),
    c = load(root);
  const rows = b.servers.filter((s) => s.mode === "dsw");
  if (!rows.length) throw new Error("no_dsw_connections_in_profile");
  const sessionsFile = path.join(root, "panel", "sessions.json");
  const sessions = fs.existsSync(sessionsFile) ? read(sessionsFile) : [];
  const operationsFile = path.join(root, "setup-operations.json");
  if (
    fs.existsSync(operationsFile) &&
    read(operationsFile).some(
      (o) => o.status === "running" && o.kind !== "connection-update",
    )
  )
    throw new Error("setup_operation_running");
  const changes = [],
    seen = new Set();
  for (const row of rows) {
    const name = id(row.name),
      old = c.servers[name];
    if (seen.has(name)) throw new Error("duplicate_server");
    seen.add(name);
    if (!old || old.mode !== "dsw") throw new Error("repair_server_not_found");
    if (old.instanceId === row.instanceId && old.region === row.region)
      continue;
    if (
      old.initialized !== false ||
      old.installStarted ||
      old.knownHostsFile ||
      sessions.some((s) => s.server === name)
    )
      throw new Error("repair_requires_unused_unverified_connections");
    const next = { ...old, instanceId: row.instanceId, region: row.region };
    validateServer(next);
    const cred = credentials(secretText(old.credentialsFile));
    if (
      !cred.accesskeyid ||
      !cred.accesskeysecret ||
      Object.values(cred).some((v) => /[\r\n\x00']/.test(v))
    )
      throw new Error("invalid_existing_dsw_credentials");
    changes.push({ name, next, cred });
  }
  if (!changes.length) return { updated: [], unchanged: true };
  const namespace = privateDir(
    path.join(
      root,
      "imports",
      "repair-" + crypto.randomBytes(12).toString("hex"),
    ),
  );
  try {
    for (const { name, next, cred } of changes) {
      next.credentialsFile = path.join(namespace, name + "-proxyclient-config");
      writeSecret(
        next.credentialsFile,
        `accesskeyid = '${cred.accesskeyid}'\naccesskeysecret = '${cred.accesskeysecret}'\nregionid = '${next.region}'\nststoken = '${cred.ststoken || ""}'\n`,
      );
      c.servers[name] = next;
    }
    save(c, root);
    return {
      updated: changes.map((s) => s.name),
      requiresHostVerification: true,
    };
  } catch (e) {
    fs.rmSync(namespace, { recursive: true, force: true });
    throw e;
  }
}
