import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { load, writePrivate, privateDir } from "./config.mjs";
import { Remote } from "./transport.mjs";
import { modelChoices } from "./models.mjs";
import { makeSession } from "./session.mjs";
import { Addons, features } from "./addons.mjs";
import { nativeDefinition } from "./native-tools.mjs";
import {
  Attachments,
  attachmentMarker,
  markerPattern,
} from "./attachments.mjs";
import { toTraditional } from "./chinese.mjs";

const uid = () => crypto.randomBytes(16).toString("hex");
export const safeError = (e) =>
  /^[a-z0-9_]{1,100}$/.test(e?.message || "") ? e.message : "operation_failed";
const message = (m) => ({
  role: m.role,
  content: (Array.isArray(m.content)
    ? m.content
    : [{ type: "text", text: m.content || "" }]
  )
    .filter((c) => ["text", "thinking", "toolCall"].includes(c.type))
    .map((c) =>
      c.type === "text" ? { ...c, text: c.text.replace(markerPattern, "") } : c,
    ),
  attachments: (Array.isArray(m.content) ? m.content : []).flatMap((c) =>
    c.type === "text"
      ? [...c.text.matchAll(markerPattern)].map((x) => x[1])
      : [],
  ),
  native: m.native,
  usage: m.usage,
  error:
    m.stopReason === "error"
      ? safeError({ message: m.errorMessage })
      : undefined,
  toolName: m.toolName,
  toolCallId: m.toolCallId,
  isError: m.isError,
  timestamp: m.timestamp,
});
export class PanelStore {
  constructor(
    root,
    {
      remoteFactory = (c, r) => new Remote(c, r),
      sessionFactory = makeSession,
    } = {},
  ) {
    this.root = root;
    this.dir = privateDir(path.join(root, "panel"));
    this.file = path.join(this.dir, "sessions.json");
    this.remoteFactory = remoteFactory;
    this.sessionFactory = sessionFactory;
    this.live = new Map();
    this.health = {};
    this.epoch = uid();
    this.closed = false;
    this.rows = fs.existsSync(this.file)
      ? JSON.parse(fs.readFileSync(this.file, "utf8"))
      : [];
    for (const r of this.rows) {
      if (r.status === "thinking" || r.status === "tool")
        r.status = "interrupted";
      r.rev = (r.rev || 0) + 1;
    }
    this.save();
    this.refreshing = false;
    this.refresh();
    this.timer = setInterval(() => this.refresh(), 5000);
    this.timer.unref();
  }
  save() {
    writePrivate(this.file, this.rows);
  }
  get(id) {
    const row = this.rows.find((r) => r.id === id);
    if (!row) throw new Error("session_not_found");
    return row;
  }
  config(r) {
    const c = load(this.root);
    if (r.mode !== "chat" && !c.servers[r.server])
      throw new Error("server_not_configured");
    return {
      ...c,
      mode: r.mode || "workspace",
      activeServer: r.server,
      workspace: r.workspace,
      model: r.model,
      effort: r.effort,
      features: features(r.features),
      sessionId: r.id,
    };
  }
  remote(r) {
    if (r.mode === "chat")
      return {
        call: async () => {
          throw new Error("conversation_has_no_execution_environment");
        },
      };
    const remote = this.remoteFactory(this.config(r), this.root);
    return {
      call: async (op, args = {}, opts = {}) => {
        const data = await remote.call(op, args, opts);
        if (op === "job.submit" && data.id) {
          if (!r.jobs.some((j) => j.id === data.id))
            r.jobs.push({
              ...data,
              command: args.command,
              createdAt: Date.now(),
            });
          this.touch(r);
        }
        return data;
      },
    };
  }
  touch(r) {
    r.rev = (r.rev || 0) + 1;
    r.updatedAt = Date.now();
    this.save();
  }
  list() {
    return this.rows.map(({ messages, pending, addonRevision, ...r }) => ({
      ...r,
      jobs: r.jobs.map(({ command, ...j }) => j),
    }));
  }
  async create({ title, server }) {
    if (typeof title !== "string" || !title.trim() || title.length > 100)
      throw new Error("invalid_session_title");
    const config = load(this.root);
    const chat = server === "__chat__" || !server;
    if (!chat && !Object.hasOwn(config.servers, server))
      throw new Error("server_not_configured");
    if (!chat && config.servers[server].initialized === false)
      throw new Error("server_initialization_required");
    if (this.rows.length >= 200) throw new Error("session_limit");
    const remote = chat
        ? null
        : this.remoteFactory({ ...config, activeServer: server }, this.root),
      workspace = chat ? uid() : (await remote.call("workspace.create")).id;
    if (!/^[a-f0-9]{32}$/.test(workspace)) throw new Error("invalid_workspace");
    const row = {
      id: uid(),
      title: title.trim(),
      server: chat ? "__chat__" : server,
      mode: chat ? "chat" : "workspace",
      workspace,
      model: config.model,
      effort: config.effort,
      features: features(config.features),
      status: "idle",
      createdAt: Date.now(),
      messages: [],
      jobs: [],
      rev: 0,
    };
    this.rows.unshift(row);
    this.touch(row);
    return row;
  }
  sync(r, session, partial) {
    const next = session.messages
      .filter((m) => ["user", "assistant", "toolResult"].includes(m.role))
      .map((m, i) => ({ id: String(i), ...message(m) }));
    if (partial && !session.messages.includes(partial))
      next.push({ id: "live", ...message(partial) });
    const signature = JSON.stringify(next),
      old = r.messages.map(({ rev, ...m }) => m);
    if (signature === JSON.stringify(old)) return;
    const rev = r.rev + 1;
    r.messages = next.map((m) => {
      const prior = r.messages.find((x) => x.id === m.id);
      return {
        ...m,
        rev:
          prior &&
          JSON.stringify(m) === JSON.stringify((({ rev, ...x }) => x)(prior))
            ? prior.rev
            : rev,
      };
    });
    this.touch(r);
  }
  async session(r) {
    const revision = crypto
      .createHash("sha256")
      .update(JSON.stringify(new Addons(this.root).read()))
      .digest("hex");
    if (this.live.has(r.id) && r.addonRevision !== revision) {
      this.live.get(r.id).dispose();
      this.live.delete(r.id);
    }
    if (this.live.has(r.id)) return this.live.get(r.id);
    const made = await this.sessionFactory(
      this.config(r),
      this.root,
      this.remote(r),
    );
    const s = made.session;
    this.live.set(r.id, s);
    r.addonRevision = revision;
    this.sync(r, s);
    s.subscribe((e) => {
      if (e.type === "tool_execution_start") {
        r.status = "tool";
        r.tool = e.toolName;
        this.touch(r);
      }
      if (e.type === "tool_execution_end") {
        r.status = "thinking";
        delete r.tool;
        this.touch(r);
      }
      if (e.type === "message_update") {
        const running = e.message?.native?.tools?.findLast(
          (t) => t.status === "running",
        );
        if (e.message?.native) {
          r.status = running ? "tool" : "thinking";
          if (running) r.tool = running.name;
          else delete r.tool;
        }
        // Throttle persistence of token deltas; full messages are flushed on end.
        if (Date.now() - (r.lastFlush || 0) > 250) {
          r.lastFlush = Date.now();
          this.sync(r, s, e.message);
        }
      }
      if (e.type === "message_end") this.sync(r, s, e.message);
    });
    return s;
  }
  async send(id, { text, requestId, attachments = [] }) {
    const r = this.get(id);
    if (typeof requestId !== "string" || !/^[a-f0-9-]{16,64}$/.test(requestId))
      throw new Error("request_id_required");
    if (r.lastRequest === requestId) return { accepted: true, duplicate: true };
    if (["thinking", "tool"].includes(r.status))
      throw new Error("session_busy");
    if (
      typeof text !== "string" ||
      !text.trim() ||
      Buffer.byteLength(text) > 128 * 1024
    )
      throw new Error("invalid_message");
    const feature = features(r.features),
      resolved = new Addons(this.root).resolve(feature);
    nativeDefinition(feature, resolved, r.model);
    const files = new Attachments(this.root, id);
    files.validate(attachments, feature.codeExecution);
    const prompt =
      toTraditional(text) +
      attachments.map((x) => "\n" + attachmentMarker(x)).join("");
    r.status = "thinking";
    r.startedAt = Date.now();
    r.error = null;
    this.touch(r);
    let s;
    try {
      s = await this.session(r);
    } catch (e) {
      r.status = "error";
      r.error = safeError(e);
      this.touch(r);
      throw e;
    }
    r.lastRequest = requestId;
    this.touch(r);
    r.pending = s
      .prompt(prompt)
      .then(() => {
        const last = s.messages.at(-1);
        r.status = last?.stopReason === "error" ? "error" : "idle";
        if (r.status === "error")
          r.error =
            safeError({ message: last.errorMessage }) ||
            "model_request_failed_check_api_key_or_proxy";
      })
      .catch((e) => {
        r.status = "error";
        r.error = safeError(e);
      })
      .finally(() => {
        delete r.pending;
        delete r.tool;
        r.finishedAt = Date.now();
        this.sync(r, s);
        this.touch(r);
      });
    return { accepted: true };
  }
  async stop(id) {
    const r = this.get(id),
      s = this.live.get(id);
    if (s) await s.abort();
    return { stopped: true };
  }
  async settings(id, { model, effort, features: selected }) {
    const r = this.get(id);
    if (["thinking", "tool"].includes(r.status))
      throw new Error("session_busy");
    if (
      typeof model !== "string" ||
      !(await modelChoices(this.root)).some((m) => m.id === model) ||
      !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
        effort,
      )
    )
      throw new Error("invalid_model_settings");
    const next = features(selected === undefined ? r.features : selected);
    nativeDefinition(next, new Addons(this.root).resolve(next), model);
    this.live.get(id)?.dispose();
    this.live.delete(id);
    r.model = model;
    r.effort = effort;
    r.features = next;
    this.touch(r);
    return { model, effort, features: next };
  }
  delta(id, cursor, epoch) {
    const r = this.get(id),
      reset = epoch !== this.epoch;
    return {
      epoch: this.epoch,
      revision: r.rev,
      reset,
      ids: r.messages.map((m) => m.id),
      messages: r.messages.filter((m) => reset || m.rev > cursor),
      session: this.list().find((x) => x.id === id),
    };
  }
  async refresh() {
    if (this.refreshing || this.closed) return;
    this.refreshing = true;
    try {
      const config = load(this.root);
      for (const server of Object.keys(config.servers).filter(
        (n) => config.servers[n].initialized !== false,
      )) {
        try {
          const h = await this.remoteFactory(
            { ...config, activeServer: server },
            this.root,
          ).call("health", {}, { timeout: 10000 });
          this.health[server] = {
            ready: h.ready,
            networkReady: h.egress_ready,
            cpus: h.cpus,
            memoryGiB: h.memory_gib,
            gpus: h.gpus,
            checkedAt: Date.now(),
          };
        } catch (e) {
          this.health[server] = {
            ready: false,
            error: safeError(e),
            checkedAt: Date.now(),
          };
        }
      }
      for (const row of this.rows) {
        for (const job of row.jobs.filter((j) => !j.released)) {
          try {
            Object.assign(
              job,
              await this.remote(row).call(
                "job.status",
                { job: job.id },
                { timeout: 10000 },
              ),
            );
            delete job.queryError;
          } catch (e) {
            job.queryError = safeError(e);
          }
        }
      }
      if (!this.closed) this.save();
    } finally {
      this.refreshing = false;
    }
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    for (const s of this.live.values()) {
      await s.abort();
      s.dispose();
    }
    this.save();
  }
}
