import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fetch, FormData } from "undici";
import { privateDir, writePrivate } from "./config.mjs";

export const attachmentMarker = (id) => `[[starport-file:${id}]]`;
export const markerPattern = /\[\[starport-file:([a-f0-9]{32})\]\]/g;
export const fileTypes = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
};
const textExtensions = new Set(
  "txt md markdown csv tsv json jsonl yaml yml xml py js jsx ts tsx mjs cjs c cpp h hpp rs go java css html sql toml ini sh ps1 log svg".split(
    " ",
  ),
);
const hash = (b) => crypto.createHash("sha256").update(b).digest("hex");
export const fileType = (name) =>
  fileTypes[name.split(".").at(-1)?.toLowerCase()] ||
  "application/octet-stream";
export class AnthropicFiles {
  constructor(root, request = fetch) {
    this.root = root;
    this.request = request;
  }
  async call(route, options = {}) {
    const secrets = JSON.parse(
      fs.readFileSync(path.join(this.root, "secrets.json"), "utf8"),
    );
    if (!secrets.anthropicApiKey) throw new Error("configure_api_key_first");
    const r = await this.request("https://api.anthropic.com/v1/files" + route, {
      ...options,
      redirect: "error",
      signal: options.signal || AbortSignal.timeout(120000),
      headers: {
        "x-api-key": secrets.anthropicApiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "files-api-2025-04-14",
        ...options.headers,
      },
    });
    if (!r.ok) {
      await r.body?.cancel();
      throw new Error("anthropic_files_request_failed");
    }
    return r;
  }
  async upload(bytes, name, signal) {
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: fileType(name) }), name);
    return (await this.call("", { method: "POST", body: form, signal })).json();
  }
}
export class Attachments {
  constructor(root, session, { files } = {}) {
    if (!/^[a-f0-9]{32}$/.test(session || ""))
      throw new Error("invalid_attachment_session");
    this.root = root;
    this.session = session;
    this.dir = privateDir(path.join(root, "attachments", session));
    this.file = path.join(this.dir, "index.json");
    this.api = files || new AnthropicFiles(root);
  }
  read() {
    return fs.existsSync(this.file)
      ? JSON.parse(fs.readFileSync(this.file, "utf8"))
      : { items: {}, cloud: {} };
  }
  save(d) {
    writePrivate(this.file, d);
  }
  list() {
    return Object.values(this.read().items)
      .filter((x) => x.complete)
      .map(({ cloudId, ...x }) => x);
  }
  begin({ name, bytes, sha256 }) {
    if (
      typeof name !== "string" ||
      name.length > 240 ||
      !name ||
      /[\\/\x00-\x1f]/.test(name) ||
      [".", ".."].includes(name)
    )
      throw new Error("invalid_filename");
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > 20 * 1024 ** 2)
      throw new Error(
        "attachment_limit_20_mib_use_project_upload_for_large_files",
      );
    if (!/^[a-f0-9]{64}$/.test(sha256 || ""))
      throw new Error("invalid_checksum");
    const d = this.read();
    const existing = Object.values(d.items).find(
      (x) => x.sha256 === sha256 && x.bytes === bytes && x.name === name,
    );
    if (existing)
      return {
        id: existing.id,
        offset: fs.statSync(path.join(this.dir, existing.id)).size,
      };
    if (
      Object.values(d.items).reduce((n, x) => n + x.bytes, 0) + bytes >
      200 * 1024 ** 2
    )
      throw new Error("session_attachment_storage_limit");
    const id = crypto.randomBytes(16).toString("hex");
    fs.writeFileSync(path.join(this.dir, id), "", { mode: 0o600 });
    d.items[id] = { id, name, bytes, sha256, complete: false };
    this.save(d);
    return { id, offset: 0 };
  }
  item(id, complete = true) {
    if (!/^[a-f0-9]{32}$/.test(id || ""))
      throw new Error("attachment_not_found");
    const x = this.read().items[id];
    if (!x || (complete && !x.complete))
      throw new Error("attachment_not_found");
    return x;
  }
  chunk({ upload, offset, data, sha256 }) {
    const x = this.item(upload, false),
      b = Buffer.from(data || "", "base64"),
      file = path.join(this.dir, x.id),
      size = fs.statSync(file).size;
    if (
      !b.length ||
      b.length > 1024 ** 2 ||
      hash(b) !== sha256 ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset + b.length > x.bytes
    )
      throw new Error("invalid_attachment_chunk");
    if (offset < size) {
      const fd = fs.openSync(file, "r"),
        old = Buffer.alloc(b.length);
      try {
        fs.readSync(fd, old, 0, b.length, offset);
      } finally {
        fs.closeSync(fd);
      }
      if (offset + b.length > size || !old.equals(b))
        throw new Error("attachment_offset_mismatch");
    } else if (offset === size && !x.complete) fs.appendFileSync(file, b);
    else throw new Error("attachment_offset_mismatch");
    return { offset: fs.statSync(file).size };
  }
  finish({ upload }) {
    const x = this.item(upload, false),
      b = fs.readFileSync(path.join(this.dir, x.id));
    if (b.length !== x.bytes || hash(b) !== x.sha256)
      throw new Error("attachment_integrity");
    const d = this.read();
    d.items[x.id].complete = true;
    this.save(d);
    return { ...x, complete: true };
  }
  register(ids = []) {
    if (!ids.length) return;
    const d = this.read();
    for (const id of ids)
      if (/^file_[a-zA-Z0-9_-]+$/.test(id)) d.cloud[id] ||= { id };
    this.save(d);
  }
  async cloud(id) {
    const metadata = await this.cloudMetadata(id);
    return { metadata, response: await this.api.call("/" + id + "/content") };
  }
  async cloudMetadata(id) {
    if (!/^file_[a-zA-Z0-9_-]+$/.test(id || "") || !this.read().cloud[id])
      throw new Error("attachment_not_found");
    const data = await (await this.api.call("/" + id)).json();
    return {
      filename: data.filename,
      size_bytes: data.size_bytes,
      mime_type: data.mime_type,
    };
  }
  validate(ids, codeExecution) {
    if (!Array.isArray(ids) || ids.length > 10)
      throw new Error("attachment_selection_limit");
    let bytes = 0;
    for (const id of ids) {
      const x = this.item(id),
        ext = x.name.split(".").at(-1).toLowerCase(),
        type = fileType(x.name);
      bytes += x.bytes;
      if (type.startsWith("image/") && x.bytes > 4 * 1024 ** 2)
        throw new Error("image_attachment_limit_4_mib");
      if (type === "application/pdf" && x.bytes > 8 * 1024 ** 2)
        throw new Error("pdf_attachment_limit_8_mib");
      if (textExtensions.has(ext) && x.bytes > 1024 ** 2 && !codeExecution)
        throw new Error("text_attachment_limit_1_mib_use_code_execution");
      if (
        !textExtensions.has(ext) &&
        !type.startsWith("image/") &&
        type !== "application/pdf" &&
        !codeExecution
      )
        throw new Error("file_analysis_requires_code_execution");
    }
    if (bytes > 20 * 1024 ** 2)
      throw new Error("message_attachment_total_limit_20_mib");
    return ids;
  }
  async inject(payload, { codeExecution, signal }) {
    for (const m of payload.messages) {
      if (m.role !== "user" || !Array.isArray(m.content)) continue;
      const expanded = [];
      for (const block of m.content) {
        if (block.type !== "text") {
          expanded.push(block);
          continue;
        }
        const ids = [...block.text.matchAll(markerPattern)].map((m) => m[1]);
        expanded.push({
          ...block,
          text:
            block.text.replace(markerPattern, "").trim() || "Attached files",
        });
        for (const id of [...new Set(ids)]) {
          const x = this.item(id),
            b = fs.readFileSync(path.join(this.dir, id)),
            type = fileType(x.name),
            ext = x.name.split(".").at(-1).toLowerCase();
          if (hash(b) !== x.sha256) throw new Error("attachment_integrity");
          if (type.startsWith("image/"))
            expanded.push({
              type: "image",
              source: {
                type: "base64",
                media_type: type,
                data: b.toString("base64"),
              },
            });
          else if (type === "application/pdf")
            expanded.push({
              type: "document",
              title: x.name,
              source: {
                type: "base64",
                media_type: type,
                data: b.toString("base64"),
              },
            });
          else if (textExtensions.has(ext) && b.length <= 1024 ** 2)
            expanded.push({
              type: "document",
              title: x.name,
              source: {
                type: "text",
                media_type: "text/plain",
                data: b.toString("utf8"),
              },
            });
          else {
            if (!codeExecution) {
              expanded.push({
                type: "text",
                text: `Previously attached file: ${x.name}. Code execution is disabled for this request.`,
              });
              continue;
            }
            let cloudId = x.cloudId;
            if (!cloudId) {
              const uploaded = await this.api.upload(b, x.name, signal);
              if (!/^file_[a-zA-Z0-9_-]+$/.test(uploaded.id || ""))
                throw new Error("invalid_files_response");
              cloudId = uploaded.id;
              const d = this.read();
              d.items[id].cloudId = cloudId;
              this.save(d);
            }
            payload.betas = [
              ...new Set([...(payload.betas || []), "files-api-2025-04-14"]),
            ];
            expanded.push({ type: "container_upload", file_id: cloudId });
          }
        }
      }
      m.content = expanded;
    }
    return payload;
  }
}
