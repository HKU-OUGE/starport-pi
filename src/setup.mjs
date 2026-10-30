import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import {
  load,
  save,
  id,
  privateDir,
  writePrivate,
  validateServer,
} from "./config.mjs";
import {
  importSubscription,
  listNodes,
  startProxy,
  refreshSubscription,
  proxyStatus,
} from "./network.mjs";
import {
  installTool,
  verifiedDownload,
  rootfsRelease,
} from "./install-tools.mjs";
import { installRemote } from "./install-remote.mjs";
import { Remote, sshArgs, processCall } from "./transport.mjs";
import { findKeys, elevatedMatch, publicKey, fingerprint } from "./keys.mjs";
import { Cloudflare, Enrollment, readEnrollment } from "./cloudflare.mjs";
import { safeError } from "./panel-store.mjs";
import { modelChoices } from "./models.mjs";
import {
  exportProfile,
  importProfile,
  decodeProfile,
  profileSummary,
  updateUnverifiedConnections,
} from "./profile-transfer.mjs";
import { installLocal } from "./install-local.mjs";
import { closeLocalBridges } from "./local-bridge.mjs";
import { Addons } from "./addons.mjs";

export function parseSshCommand(value) {
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    /[\r\n\x00;&|`$<>]/.test(value)
  )
    throw new Error("invalid_ssh_command");
  const tokens =
    value
      .match(/"[^"]*"|'[^']*'|\S+/g)
      ?.map((v) => v.replace(/^(["'])(.*)\1$/, "$2")) || [];
  if (!["ssh", "ssh.exe"].includes(tokens.shift()))
    throw new Error("ssh_command_required");
  let port = 22,
    user,
    host;
  while (tokens.length) {
    const t = tokens.shift();
    if (t === "-p") port = Number(tokens.shift());
    else if (t === "-l") user = tokens.shift();
    else if (t === "-i") {
      if (!tokens.shift()) throw new Error("invalid_ssh_command");
    } else if (t.startsWith("-") || host)
      throw new Error("unsupported_ssh_option_use_connection_fields");
    else host = t;
  }
  if (user) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(user) || host?.includes("@"))
      throw new Error("invalid_ssh_user");
    host = user + "@" + host;
  }
  return validateServer({ mode: "ssh", host, port });
}
const saveText = (file, text) => {
  privateDir(path.dirname(file));
  fs.writeFileSync(file, text, { mode: 0o600 });
  if (process.platform !== "win32") fs.chmodSync(file, 0o600);
};
export async function verifyWorker(
  remote,
  { delay = () => new Promise((r) => setTimeout(r, 2000)) } = {},
) {
  const test = await remote.call("job.submit", {
    command: "python3 /opt/starport/probe.py",
    cpus: 1,
    memory_gib: 2,
    timeout: 120,
  });
  let final;
  for (let n = 0; n < 75; n++) {
    await delay();
    final = await remote.call("job.status", { job: test.id });
    if (final.released) break;
  }
  const logs = await remote.call("job.logs", { job: test.id, cursor: 0 });
  const checks = logs.text.split("\n").flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
  if (
    !final?.released ||
    final.status !== "completed" ||
    final.exit_code !== 0 ||
    !checks.some(
      (c) =>
        c.passed === true &&
        c.direct_network_blocked === true &&
        c.machine_id_empty === true,
    )
  )
    throw new Error("isolation_probe_failed_server_not_enabled");
  return { job: test.id, verified: true };
}
export class Setup {
  constructor(
    root,
    {
      port,
      store,
      install = installRemote,
      tool = installTool,
      execute = processCall,
    } = {},
  ) {
    this.root = root;
    this.port = port;
    this.store = store;
    this.install = install;
    this.tool = tool;
    this.runProcess = execute;
    this.foundKeys = new Map();
    this.connector = null;
    this.operationsFile = path.join(root, "setup-operations.json");
    this.operations = fs.existsSync(this.operationsFile)
      ? JSON.parse(fs.readFileSync(this.operationsFile, "utf8"))
      : [];
    for (const op of this.operations)
      if (op.status === "running") {
        op.status = "interrupted";
        op.error = "inspect_state_before_resuming";
      }
  }
  snapshot() {
    const c = load(this.root),
      cfFile = path.join(this.root, "cloudflare", "receipt.json");
    const cf = fs.existsSync(cfFile)
      ? JSON.parse(fs.readFileSync(cfFile, "utf8"))
      : null;
    const draftFile = path.join(this.root, "cloudflare", "enrollment.json");
    const draft = fs.existsSync(draftFile)
      ? JSON.parse(fs.readFileSync(draftFile, "utf8"))
      : null;
    return {
      model: c.model,
      platform: process.platform,
      cloudflareDraft: draft
        ? {
            zone: draft.zone,
            prefix: draft.prefix || "console",
            allowedEmails: draft.allowedEmails,
            tokenConfigured: fs.existsSync(
              path.join(this.root, "cloudflare", "api-token"),
            ),
          }
        : null,
      apiKeyConfigured: fs.existsSync(path.join(this.root, "secrets.json")),
      nodes: listNodes(c, this.root),
      selectedNode: c.proxy.selected || null,
      subscriptions: c.subscriptions,
      servers: Object.entries(c.servers).map(([name, s]) => ({
        name,
        mode: s.mode,
        initialized: s.initialized !== false,
        hostVerified: Boolean(s.knownHostsFile),
        budget: s.budget,
      })),
      operations: this.operations,
      cloudflare: cf
        ? {
            stage: cf.stage,
            url: "https://" + cf.hostname,
            allowedEmails: cf.allowedEmails,
          }
        : null,
      connectorRunning: Boolean(
        this.connector && this.connector.exitCode === null,
      ),
      defaultKeyDirectory: path.join(os.homedir(), ".ssh"),
    };
  }
  record(op) {
    op.updatedAt = Date.now();
    writePrivate(this.operationsFile, this.operations);
  }
  start(kind, action) {
    if (this.operations.some((o) => o.status === "running"))
      throw new Error("setup_operation_running");
    const op = {
      id: crypto.randomBytes(16).toString("hex"),
      kind,
      status: "running",
      stage: "starting",
      startedAt: Date.now(),
    };
    this.operations.unshift(op);
    this.operations = this.operations.slice(0, 50);
    this.record(op);
    const stage = (name, detail) => {
      op.stage = name;
      op.detail = detail;
      this.record(op);
    };
    this.pending = Promise.resolve()
      .then(() => action(stage))
      .then((result) => {
        op.status = "complete";
        op.result = result;
      })
      .catch((e) => {
        op.status = "failed";
        op.error = safeError(e);
      })
      .finally(() => {
        try {
          this.record(op);
        } catch {
          // A full or unwritable state disk must not turn an already classified
          // failure into an unhandled rejection that takes down the panel.
          if (op.status !== "failed") {
            op.status = "failed";
            op.error = "setup_state_write_failed";
          }
        }
      });
    return { operation: op.id };
  }
  async dispatch(action, input = {}) {
    if (action === "addons-list") return new Addons(this.root).list();
    if (action === "addons-save")
      return new Addons(this.root).save(input.kind, input.item);
    if (action === "addons-remove")
      return new Addons(this.root).remove(input.kind, input.id);
    const c = load(this.root);
    if (action === "state")
      return {
        ...this.snapshot(),
        models: await modelChoices(this.root),
        proxy: await proxyStatus(c, this.root),
      };
    if (action === "config-export")
      return {
        bundle: await exportProfile(this.root, {
          includeSecrets: true,
          password: input.password,
        }),
      };
    if (action === "local-initialize")
      return this.start("local-runtime", (stage) =>
        installLocal(this.root, {
          cpus: input.cpus,
          memoryGiB: input.memoryGiB,
          stage,
          verify: verifyWorker,
        }),
      );
    if (action === "config-preview")
      return profileSummary(await decodeProfile(input.bundle, input.password));
    if (action === "config-update-connections")
      return this.start("connection-update", () =>
        updateUnverifiedConnections(this.root, input.bundle, input.password),
      );
    if (action === "config-import")
      return this.start("configuration", async (stage) => {
        stage("importing_configuration");
        const result = await importProfile(
          this.root,
          input.bundle,
          input.password,
        );
        const next = load(this.root);
        if (input.activateNetwork && next.proxy.selected) {
          stage("installing_mihomo");
          next.proxy.binary = await this.tool(this.root, "mihomo");
          save(next, this.root);
          stage("applying_proxy");
          await startProxy(next, this.root);
        }
        return result;
      });
    if (action === "model") {
      if (input.apiKey) {
        if (
          typeof input.apiKey !== "string" ||
          !input.apiKey.startsWith("sk-ant-") ||
          input.apiKey.length > 1024
        )
          throw new Error("invalid_api_key");
        writePrivate(path.join(this.root, "secrets.json"), {
          anthropicApiKey: input.apiKey,
        });
      }
      if (input.model) {
        if (!(await modelChoices(this.root)).some((m) => m.id === input.model))
          throw new Error("invalid_model");
        c.model = input.model;
      }
      save(c, this.root);
      return { saved: true };
    }
    if (action === "network-import")
      return this.start("network", async (stage) => {
        stage("importing_subscription");
        let result;
        if (input.text) {
          if (
            typeof input.text !== "string" ||
            Buffer.byteLength(input.text) > 4 * 1024 * 1024
          )
            throw new Error("subscription_too_large");
          const file = path.join(this.root, "subscription-import");
          saveText(file, input.text);
          try {
            result = await importSubscription(
              c,
              this.root,
              input.label || "Subscription",
              file,
              { remote: false },
            );
          } finally {
            fs.rmSync(file, { force: true });
          }
        } else
          result = await importSubscription(
            c,
            this.root,
            input.label || "Subscription",
            input.url,
          );
        return result;
      });
    if (action === "network-refresh")
      return this.start("network", () =>
        refreshSubscription(c, this.root, input.id),
      );
    if (action === "network-apply")
      return this.start("network", async (stage) => {
        if (!listNodes(c, this.root).some((n) => n.id === input.node))
          throw new Error("invalid_node_selection");
        stage("installing_mihomo");
        c.proxy.binary = await this.tool(this.root, "mihomo");
        c.proxy.selected = input.node;
        save(c, this.root);
        stage("applying_proxy");
        return startProxy(c, this.root);
      });
    if (action === "key-scan" || action === "key-scan-admin") {
      if (action === "key-scan-admin" && (!input.publicKey || !input.directory))
        throw new Error("public_key_and_directory_required");
      const rows =
        action === "key-scan-admin"
          ? [await elevatedMatch(this.root, input.directory, input.publicKey)]
          : await findKeys({
              directory: input.directory || undefined,
              publicKey: input.publicKey || undefined,
            });
      return {
        keys: rows.map((row) => {
          if (row.locked) return row;
          const keyId = crypto.randomBytes(16).toString("hex");
          this.foundKeys.set(keyId, row);
          return {
            keyId,
            name: row.name,
            fingerprint: row.fingerprint,
            publicKey: row.publicKey,
          };
        }),
      };
    }
    if (action === "key-generate") {
      const dir = privateDir(path.join(this.root, "keys")),
        file = path.join(dir, "key-" + crypto.randomBytes(6).toString("hex"));
      await processCall(
        "ssh-keygen",
        ["-t", "ed25519", "-C", "starport", "-N", "", "-f", file],
        "",
      );
      const key = fs.readFileSync(file, "utf8"),
        pub = publicKey(fs.readFileSync(file + ".pub", "utf8")),
        keyId = crypto.randomBytes(16).toString("hex");
      this.foundKeys.set(keyId, {
        file,
        name: "Generated key",
        publicKey: pub,
        fingerprint: fingerprint(pub),
        sha256: crypto.createHash("sha256").update(key).digest("hex"),
      });
      return { keyId, publicKey: pub, fingerprint: fingerprint(pub) };
    }
    if (action === "server-add") {
      const name = id(input.name);
      if (c.servers[name]) throw new Error("server_alias_exists");
      const dir = privateDir(path.join(this.root, "connections", name)),
        identityFile = path.join(dir, "identity");
      let privateKey = input.privateKey;
      if (input.keyId) {
        const found = this.foundKeys.get(input.keyId);
        if (!found) throw new Error("key_selection_expired");
        privateKey = fs.readFileSync(found.file, "utf8");
        if (
          crypto.createHash("sha256").update(privateKey).digest("hex") !==
          found.sha256
        )
          throw new Error("selected_key_changed");
      }
      if (
        typeof privateKey !== "string" ||
        privateKey.length > 65536 ||
        !/^-----BEGIN (OPENSSH |RSA |EC |ENCRYPTED )?PRIVATE KEY-----/.test(
          privateKey.trim(),
        )
      )
        throw new Error("private_key_required");
      let server;
      if (input.mode === "dsw") {
        server = {
          mode: "dsw",
          instanceId: input.instanceId,
          region: input.region,
          user: input.user || "root",
          proxyClient: path.join(
            this.root,
            "tools",
            "proxyclient" + (process.platform === "win32" ? ".exe" : ""),
          ),
          credentialsFile: path.join(dir, "proxyclient-config"),
          identityFile,
        };
        validateServer(server);
        if (
          !input.accessKeyId ||
          !input.accessKeySecret ||
          [input.accessKeyId, input.accessKeySecret, input.stsToken || ""].some(
            (v) =>
              typeof v !== "string" ||
              /[\r\n\x00']/.test(v) ||
              v.length > 16384,
          )
        )
          throw new Error("invalid_cloud_credentials");
        saveText(
          server.credentialsFile,
          `accesskeyid = '${input.accessKeyId}'\naccesskeysecret = '${input.accessKeySecret}'\nregionid = '${input.region}'\nststoken = '${input.stsToken || ""}'\n`,
        );
      } else server = { ...parseSshCommand(input.command), identityFile };
      saveText(identityFile, privateKey.trim() + "\n");
      server.initialized = false;
      server.budget = {
        cpus: Number(input.cpus),
        memoryGiB: Number(input.memoryGiB),
        gpus: input.gpus || [],
      };
      if (
        !Number.isInteger(server.budget.cpus) ||
        server.budget.cpus < 1 ||
        server.budget.cpus > 512 ||
        !Number.isInteger(server.budget.memoryGiB) ||
        server.budget.memoryGiB < 2 ||
        server.budget.memoryGiB > 4096 ||
        !Array.isArray(server.budget.gpus) ||
        server.budget.gpus.some((x) => !Number.isInteger(x) || x < 0 || x > 63)
      )
        throw new Error("invalid_server_budget");
      c.servers[name] = server;
      save(c, this.root);
      return { name, next: "server-scan" };
    }
    if (action === "server-scan")
      return this.start("server-scan", async (stage) => {
        const server = c.servers[id(input.name)];
        if (!server) throw new Error("server_not_found");
        if (server.mode === "dsw") {
          stage("installing_proxyclient");
          server.proxyClient = await this.tool(this.root, "proxyclient");
          save(c, this.root);
        }
        const scanFile = path.join(
          this.root,
          "connections",
          input.name,
          "host-key-scan",
        );
        privateDir(path.dirname(scanFile));
        const proxyReport = path.join(
          path.dirname(scanFile),
          "proxy-status.json",
        );
        fs.rmSync(proxyReport, { force: true });
        fs.rmSync(scanFile, { force: true });
        const args = sshArgs(
          input.name,
          { ...server, knownHostsFile: scanFile },
          this.root,
        ).map((x) =>
          x === "StrictHostKeyChecking=yes"
            ? "StrictHostKeyChecking=accept-new"
            : x,
        );
        args.splice(
          args.length - 1,
          0,
          "-o",
          "PreferredAuthentications=none",
          "-o",
          "PubkeyAuthentication=no",
          "-o",
          "PasswordAuthentication=no",
          "-o",
          "KbdInteractiveAuthentication=no",
        );
        stage("reading_host_key");
        try {
          await this.runProcess("ssh", [...args, "true"], "", {
            timeout: 30000,
          });
        } catch {
          /* Authentication is deliberately disabled until the key is confirmed. */
        }
        if (
          !fs.existsSync(scanFile) &&
          server.mode === "dsw" &&
          fs.existsSync(proxyReport)
        ) {
          const failure = JSON.parse(fs.readFileSync(proxyReport, "utf8"));
          if (
            [
              "dsw_instance_not_found_check_id_and_region",
              "dsw_token_permission_denied",
              "dsw_credentials_rejected",
            ].includes(failure.error)
          )
            throw new Error(failure.error);
        }
        if (!fs.existsSync(scanFile))
          throw new Error("ssh_unreachable_check_vpc_or_proxyclient");
        const lines = fs
          .readFileSync(scanFile, "utf8")
          .split("\n")
          .filter((x) => x && !x.startsWith("#"));
        const keys = lines.map((line) => {
          const p = line.split(/\s+/);
          return fingerprint(p[1] + " " + p[2]);
        });
        if (!keys.length) throw new Error("host_key_not_available");
        return {
          name: input.name,
          fingerprints: keys,
          next: "server-initialize",
        };
      });
    if (action === "server-initialize")
      return this.start("server-initialize", async (stage) => {
        const server = c.servers[id(input.name)];
        if (!server || server.initialized !== false)
          throw new Error("new_server_required");
        const scan = path.join(
          this.root,
          "connections",
          input.name,
          "host-key-scan",
        );
        const lines = fs
          .readFileSync(scan, "utf8")
          .split("\n")
          .filter((x) => x && !x.startsWith("#"));
        if (
          !input.fingerprint ||
          !lines.some(
            (l) =>
              fingerprint(l.split(/\s+/).slice(1, 3).join(" ")) ===
              input.fingerprint,
          )
        )
          throw new Error("confirm_host_fingerprint_first");
        server.knownHostsFile = path.join(
          this.root,
          "connections",
          input.name,
          "known_hosts",
        );
        saveText(server.knownHostsFile, lines.join("\n") + "\n");
        save(c, this.root);
        const selected = { ...c, activeServer: input.name, workspace: null },
          remote = new Remote(selected, this.root);
        stage("checking_server");
        const args = sshArgs(input.name, server, this.root);
        const preflight = JSON.parse(
          (
            await processCall(
              "ssh",
              [
                ...args,
                "python3 -I -c " +
                  "'import os,platform,pathlib,json;print(json.dumps(dict(arch=platform.machine(),cpus=len(os.sched_getaffinity(0)),existing=(pathlib.Path.home()/\".local/share/starport-pi-server\").exists())))'",
              ],
              "",
            )
          ).toString(),
        );
        if (preflight.arch !== "x86_64")
          throw new Error("release_rootfs_requires_x86_64_server");
        if (server.budget.cpus > preflight.cpus)
          throw new Error("cpu_budget_exceeds_server");
        if (!preflight.existing) {
          stage("downloading_rootfs");
          const archive = await verifiedDownload(
            this.root,
            "rootfs-v0.1.0.tar.gz",
            rootfsRelease.url,
            rootfsRelease.sha256,
            {
              proxyPort: c.proxy.port,
              onProgress: (bytes, total, detail) =>
                stage("downloading_rootfs", { bytes, total, ...detail }),
            },
          );
          stage("installing_isolated_worker");
          server.installStarted = true;
          save(c, this.root);
          await this.install(selected, this.root, archive, {
            ...server.budget,
            onDownloadProgress: (bytes, total, detail) =>
              stage("downloading_runtime", { bytes, total, ...detail }),
            onProgress: (bytes, total) =>
              stage("uploading_runtime", { bytes, total }),
          });
        } else {
          // Resume only an installation started by this profile; never adopt unknown workers.
          if (!server.installStarted)
            throw new Error("existing_worker_requires_operator_review");
        }
        stage("connecting_egress");
        await remote.tunnel(c.proxy.port);
        stage("verifying_isolation");
        selected.workspace = (await remote.call("workspace.create")).id;
        await verifyWorker(remote);
        if (server.budget.gpus.length) {
          stage("configuring_gpu");
          await remote.configureGpu(server.budget.gpus, { apply: true });
        }
        const latest = load(this.root);
        latest.servers[input.name].initialized = true;
        latest.servers[input.name].knownHostsFile = server.knownHostsFile;
        latest.activeServer = input.name;
        latest.workspace = selected.workspace;
        save(latest, this.root);
        return {
          name: input.name,
          ready: true,
          isolationVerified: true,
          gpuConfigured: server.budget.gpus.length,
        };
      });
    if (action === "cloudflare-plan") {
      const folder = privateDir(path.join(this.root, "cloudflare")),
        tokenFile = path.join(folder, "api-token"),
        file = path.join(folder, "enrollment.json");
      if (input.token) {
        if (
          typeof input.token !== "string" ||
          /[\r\n\x00]/.test(input.token) ||
          input.token.length > 16384
        )
          throw new Error("invalid_cloudflare_token");
        saveText(tokenFile, input.token);
      }
      writePrivate(file, {
        zone: input.zone,
        prefix: input.prefix || "console",
        allowedEmails: input.emails,
        port: this.port,
        tokenFile: "api-token",
      });
      const { config, token } = readEnrollment(file);
      const result = await new Enrollment(
        new Cloudflare(token),
        this.root,
      ).plan(config);
      return {
        stage: result.stage,
        url: "https://" + result.hostname,
        allowedEmails: result.allowedEmails,
      };
    }
    if (action === "cloudflare-apply" || action === "cloudflare-status") {
      const { token } = readEnrollment(
          path.join(this.root, "cloudflare", "enrollment.json"),
        ),
        enrollment = new Enrollment(new Cloudflare(token), this.root);
      const result =
        await enrollment[action === "cloudflare-apply" ? "apply" : "status"]();
      if (action === "cloudflare-apply") await this.startConnector();
      return {
        stage: result.stage,
        url: "https://" + result.hostname,
        pending: result.pending?.key || null,
      };
    }
    if (action === "cloudflare-start") {
      await this.startConnector();
      return { running: true };
    }
    throw new Error("setup_action_not_supported");
  }
  async startConnector() {
    if (this.closed) return;
    if (this.connector && this.connector.exitCode === null) return;
    const r = new Enrollment(null, this.root).read();
    if (r.stage !== "configured") throw new Error("cloudflare_apply_required");
    const binary = await this.tool(this.root, "cloudflared");
    if (this.closed) return;
    this.connector = spawn(
      binary,
      [
        "tunnel",
        "--no-autoupdate",
        "run",
        "--token-file",
        path.join(this.root, "cloudflare", "tunnel-token"),
      ],
      { stdio: "ignore", windowsHide: true, shell: false },
    );
    this.connector.on("error", () => {});
    await new Promise((resolve) => setTimeout(resolve, 700));
    if (this.connector.exitCode !== null || !this.connector.pid)
      throw new Error("cloudflare_connector_start_failed");
  }
  startMaintenance() {
    this.maintaining = false;
    const tick = async () => {
      if (
        this.closed ||
        this.maintaining ||
        this.operations.some((o) => o.status === "running")
      )
        return;
      this.maintaining = true;
      try {
        const c = load(this.root);
        if (c.proxy.binary && c.proxy.selected) {
          if (!(await proxyStatus(c, this.root)).running)
            await startProxy(c, this.root);
          for (const name of Object.keys(c.servers).filter(
            (n) => c.servers[n].initialized === true,
          )) {
            try {
              await new Remote({ ...c, activeServer: name }, this.root).tunnel(
                c.proxy.port,
              );
            } catch {
              /* The status panel reports failures; no task is cancelled. */
            }
          }
        }
        const file = path.join(this.root, "cloudflare", "receipt.json");
        if (
          fs.existsSync(file) &&
          JSON.parse(fs.readFileSync(file, "utf8")).stage === "configured"
        )
          await this.startConnector();
      } catch {
        /* No direct egress or unprotected fallback is introduced. */
      } finally {
        this.maintaining = false;
      }
    };
    this.maintenanceTimer = setInterval(tick, 30000);
    this.maintenanceTimer.unref();
    this.maintenanceStart = setTimeout(tick, 2000);
    this.maintenanceStart.unref();
  }
  close() {
    this.closed = true;
    clearInterval(this.maintenanceTimer);
    clearTimeout(this.maintenanceStart);
    this.connector?.kill();
    closeLocalBridges(
      Object.values(load(this.root).servers)
        .filter((s) => s.mode === "wsl")
        .map((s) => s.distribution),
    );
  }
}
