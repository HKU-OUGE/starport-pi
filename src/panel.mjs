import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { gzipSync } from "node:zlib";
import { getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { load, privateDir, writePrivate } from "./config.mjs";
import { requireModelProxy } from "./network.mjs";
import {
  accessConfig,
  accessProof,
  authenticate,
  localSecret,
  localCookie,
  csrfFor,
  same,
  requestPolicy,
} from "./access.mjs";
import { PanelStore, safeError } from "./panel-store.mjs";
import { Setup } from "./setup.mjs";
import { modelChoices } from "./models.mjs";
import { Addons, FEATURE_DEFAULTS } from "./addons.mjs";
import { UsageStore } from "./usage.mjs";
import { Attachments, fileType } from "./attachments.mjs";

const webRoot = fileURLToPath(new URL("../web-dist/", import.meta.url));
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".mp4": "video/mp4",
  ".pdf": "application/pdf",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
};
const validPath = (p) =>
  typeof p === "string" &&
  p.length < 1024 &&
  p.split("/").every((x) => x && x !== "." && x !== "..") &&
  !/[\\\x00-\x1f]/.test(p);
async function body(req, limit = 3 * 1024 * 1024) {
  let size = 0;
  const blocks = [];
  for await (const b of req) {
    size += b.length;
    if (size > limit) throw new Error("request_too_large");
    blocks.push(b);
  }
  try {
    return JSON.parse(Buffer.concat(blocks).toString("utf8"));
  } catch {
    throw new Error("invalid_json");
  }
}
function json(req, res, status, value) {
  let data = Buffer.from(JSON.stringify(value));
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (
    data.length > 2048 &&
    /\bgzip\b/.test(req.headers["accept-encoding"] || "")
  ) {
    data = gzipSync(data);
    res.setHeader("Content-Encoding", "gzip");
    res.setHeader("Vary", "Accept-Encoding");
  }
  res.end(data);
}
export async function startPanel(
  root,
  {
    port = 18900,
    store,
    authOptions = {},
    useModelProxy = true,
    maintenance = true,
  } = {},
) {
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("invalid_panel_port");
  privateDir(root);
  const lock = path.join(root, "panel.lock");
  if (fs.existsSync(lock)) {
    const pid = Number(fs.readFileSync(lock, "utf8"));
    let alive = true;
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
      } catch (e) {
        if (e.code === "ESRCH") alive = false;
      }
    }
    if (!alive) fs.unlinkSync(lock);
  }
  try {
    const fd = fs.openSync(lock, "wx", 0o600);
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
  } catch {
    throw new Error("panel_already_running_or_stale_lock");
  }
  let dispatcher;
  const previous = getGlobalDispatcher();
  try {
    if (useModelProxy) dispatcher = requireModelProxy(load(root));
  } catch (e) {
    fs.unlinkSync(lock);
    throw e;
  }
  const key = localSecret(root),
    db = store || new PanelStore(root),
    uploadsFile = path.join(root, "panel", "uploads.json");
  const setup = new Setup(root, { port, store: db });
  const uploads = fs.existsSync(uploadsFile)
    ? JSON.parse(fs.readFileSync(uploadsFile, "utf8"))
    : {};
  const persist = () => writePrivate(uploadsFile, uploads);
  const sessionRequests = new Map();
  let loginFailures = 0,
    loginWindow = Date.now();
  const server = http.createServer(async (req, res) => {
    let requestSession;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; media-src 'self' blob:; connect-src 'self'; frame-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    try {
      const c = accessConfig(root);
      if (c.mode === "cloudflare")
        res.setHeader("X-Starport-Access-Proof", accessProof(c));
      const local = "127.0.0.1:" + server.address().port;
      const policy = requestPolicy(req, c, server.address().port);
      const url = new URL(req.url, "http://" + local),
        p = url.pathname;
      if (!p.startsWith("/api/")) {
        if (req.method !== "GET" && req.method !== "HEAD")
          throw new Error("method_not_allowed");
        const relative = p === "/" ? "index.html" : p.replace(/^\//, "");
        if (
          !(
            relative === "index.html" ||
            /^assets\/[a-zA-Z0-9_.-]+$/.test(relative)
          )
        )
          throw new Error("file_not_found");
        const file = path.join(webRoot, relative);
        if (!fs.existsSync(file)) throw new Error("build_web_first");
        let data = fs.readFileSync(file);
        res.setHeader(
          "Content-Type",
          mime[path.extname(file)] || "application/octet-stream",
        );
        if (relative.startsWith("assets/"))
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        if (/\bgzip\b/.test(req.headers["accept-encoding"] || "")) {
          data = gzipSync(data);
          res.setHeader("Content-Encoding", "gzip");
          res.setHeader("Vary", "Accept-Encoding");
        }
        res.end(req.method === "HEAD" ? undefined : data);
        return;
      }
      if (req.method === "POST") {
        if (
          req.headers.origin !== policy.origin ||
          !String(req.headers["content-type"]).startsWith("application/json")
        )
          throw new Error("origin_not_allowed");
      }
      if (p === "/api/login" && req.method === "POST") {
        if (policy.mode !== "local")
          throw new Error("cloudflare_login_required");
        if (Date.now() - loginWindow > 60000) {
          loginWindow = Date.now();
          loginFailures = 0;
        }
        if (loginFailures >= 10) throw new Error("login_rate_limited");
        const input = await body(req, 1024);
        if (!same(input.key, key)) {
          loginFailures++;
          throw new Error("authentication_required");
        }
        res.setHeader(
          "Set-Cookie",
          "starport_session=" +
            localCookie(key) +
            "; HttpOnly; SameSite=Strict; Path=/",
        );
        json(req, res, 200, { ok: true });
        return;
      }
      const identity = await authenticate(
        req,
        policy.mode === "local" ? { mode: "local" } : c,
        key,
        authOptions,
      );
      if (
        req.method === "POST" &&
        !same(req.headers["x-starport-csrf"], csrfFor(key, identity))
      )
        throw new Error("csrf_required");
      const send = (value) => json(req, res, 200, value);
      if (p === "/api/setup" && req.method === "POST") {
        if (
          policy.mode !== "local" &&
          !same(req.headers["x-starport-admin"], key)
        )
          throw new Error("operator_key_required");
        const { action, ...input } = await body(req, 24 * 1024 * 1024);
        send(await setup.dispatch(action, input));
        return;
      }
      if (p === "/api/bootstrap" && req.method === "GET") {
        const config = load(root);
        send({
          csrf: csrfFor(key, identity),
          mode: policy.mode,
          models: await modelChoices(root),
          serverKinds: Object.fromEntries(
            Object.entries(config.servers).map(([n, s]) => [n, s.mode]),
          ),
          servers: Object.keys(config.servers).filter(
            (name) => config.servers[name].initialized !== false,
          ),
          health: db.health,
          sessions: db.list(),
          epoch: db.epoch,
          addons: new Addons(root).list(),
          featureDefaults: FEATURE_DEFAULTS,
        });
        return;
      }
      if (p === "/api/usage" && req.method === "GET") {
        const session = url.searchParams.get("session");
        if (session) db.get(session);
        send(new UsageStore(root).snapshot(session));
        return;
      }
      if (p === "/api/sessions" && req.method === "POST") {
        const r = await db.create(await body(req, 8192));
        send({ id: r.id });
        return;
      }
      if (p === "/api/logout" && req.method === "POST") {
        res.setHeader(
          "Set-Cookie",
          "starport_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
        );
        send({
          url: policy.mode === "cloudflare" ? "/cdn-cgi/access/logout" : "/",
        });
        return;
      }
      const match = p.match(
        /^\/api\/sessions\/([a-f0-9]{32})\/(messages|send|stop|settings|metadata|delete|files|file-text|file-manage|upload-begin|upload-chunk|upload-finish|logs|artifacts|cancel|download|attachments|attach-begin|attach-chunk|attach-finish|attachment|cloud-file|cloud-file-meta)$/,
      );
      if (!match) throw new Error("route_not_found");
      const [, id, op] = match;
      requestSession = id;
      sessionRequests.set(id, (sessionRequests.get(id) || 0) + 1);
      if (op === "delete" && req.method === "POST") {
        const input = await body(req, 1024);
        if (sessionRequests.get(id) > 1)
          throw new Error("session_transfers_busy");
        const result = db.remove(id, input);
        for (const [key, upload] of Object.entries(uploads))
          if (upload.session === id) delete uploads[key];
        persist();
        send(result);
        return;
      }
      const r = db.get(id);
      if (op === "metadata" && req.method === "POST") {
        send(db.metadata(id, await body(req, 8192)));
        return;
      }
      if (op === "messages" && req.method === "GET") {
        const cursor = Number(url.searchParams.get("cursor") || 0);
        send(
          db.delta(
            id,
            Number.isFinite(cursor) ? cursor : 0,
            url.searchParams.get("epoch"),
          ),
        );
        return;
      }
      if (op === "send" && req.method === "POST") {
        send(await db.send(id, await body(req, 150000)));
        return;
      }
      if (op === "stop" && req.method === "POST") {
        send(await db.stop(id));
        return;
      }
      if (op === "settings" && req.method === "POST") {
        send(await db.settings(id, await body(req, 16000)));
        return;
      }
      if (op.startsWith("attach") || op.startsWith("cloud-file")) {
        const owned = new Attachments(root, id);
        if (op === "cloud-file-meta" && req.method === "GET") {
          send(await owned.cloudMetadata(url.searchParams.get("id")));
          return;
        }
        if (op === "attachments" && req.method === "GET") {
          send({ files: owned.list() });
          return;
        }
        if (
          ["attach-begin", "attach-chunk", "attach-finish"].includes(op) &&
          req.method === "POST"
        ) {
          const input = await body(req);
          send(
            op === "attach-begin"
              ? owned.begin(input)
              : op === "attach-chunk"
                ? owned.chunk(input)
                : owned.finish(input),
          );
          return;
        }
        if (op === "attachment" && req.method === "GET") {
          const x = owned.item(url.searchParams.get("id"));
          const data = fs.readFileSync(path.join(owned.dir, x.id));
          if (
            crypto.createHash("sha256").update(data).digest("hex") !== x.sha256
          )
            throw new Error("attachment_integrity");
          const preview = url.searchParams.get("preview") === "1",
            type = fileType(x.name);
          if (preview)
            res.setHeader(
              "Content-Security-Policy",
              "default-src 'none'; frame-ancestors 'self'; sandbox",
            );
          res.setHeader(
            "Content-Type",
            preview ? type : "application/octet-stream",
          );
          res.setHeader(
            "Content-Disposition",
            (preview && type !== "application/octet-stream"
              ? "inline"
              : "attachment") +
              "; filename*=UTF-8''" +
              encodeURIComponent(x.name),
          );
          const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
          const start = range ? Number(range[1]) : 0,
            end = range?.[2]
              ? Math.min(Number(range[2]), data.length - 1)
              : data.length - 1;
          if (start > end || start >= data.length) {
            res.writeHead(416, { "Content-Range": "bytes */" + data.length });
            res.end();
            return;
          }
          res.setHeader("Accept-Ranges", "bytes");
          if (range) {
            res.statusCode = 206;
            res.setHeader(
              "Content-Range",
              `bytes ${start}-${end}/${data.length}`,
            );
          }
          res.setHeader("Content-Length", end - start + 1);
          res.end(data.subarray(start, end + 1));
          return;
        }
        if (op === "cloud-file" && req.method === "GET") {
          const { metadata, response } = await owned.cloud(
            url.searchParams.get("id"),
          );
          const name = String(metadata.filename || "artifact").replace(
              /[\\/\x00-\x1f]/g,
              "_",
            ),
            type = fileType(name);
          if (url.searchParams.get("preview") === "1")
            res.setHeader(
              "Content-Security-Policy",
              "default-src 'none'; frame-ancestors 'self'; sandbox",
            );
          res.setHeader(
            "Content-Type",
            url.searchParams.get("preview") === "1"
              ? type
              : "application/octet-stream",
          );
          res.setHeader(
            "Content-Disposition",
            (url.searchParams.get("preview") === "1" &&
            type !== "application/octet-stream"
              ? "inline"
              : "attachment") +
              "; filename*=UTF-8''" +
              encodeURIComponent(name),
          );
          try {
            for await (const b of response.body) {
              if (res.destroyed) break;
              if (!res.write(b))
                await Promise.race([once(res, "drain"), once(res, "close")]);
            }
          } finally {
            if (res.destroyed) await response.body?.cancel?.().catch(() => {});
          }
          res.end();
          return;
        }
        throw new Error("method_not_allowed");
      }
      const remote = db.remote(r);
      const job = () => {
        const j = url.searchParams.get("job");
        if (!r.jobs.some((x) => x.id === j)) throw new Error("job_not_found");
        return j;
      };
      if (op === "files" && req.method === "GET") {
        const location = url.searchParams.get("path") || ".";
        if (location !== "." && !validPath(location))
          throw new Error("invalid_path");
        send(await remote.call("file.list", { path: location }));
        return;
      }
      if (op === "file-text" && req.method === "GET") {
        const location = url.searchParams.get("path");
        if (!validPath(location)) throw new Error("invalid_path");
        const file = await remote.call("file.read", {
          path: location,
          offset: 0,
          size: 2 * 1024 * 1024,
        });
        const bytes = Buffer.from(file.data, "base64");
        if (file.total !== bytes.length || bytes.length > 2 * 1024 * 1024)
          throw new Error("text_file_too_large_or_binary");
        if (
          crypto.createHash("sha256").update(bytes).digest("hex") !==
          file.sha256
        )
          throw new Error("download_checksum");
        let text;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          throw new Error("text_file_too_large_or_binary");
        }
        if (text.includes("\0"))
          throw new Error("text_file_too_large_or_binary");
        send({ text, version: file.version });
        return;
      }
      if (op === "file-manage" && req.method === "POST") {
        const input = await body(req);
        if (r.pending || ["thinking", "tool"].includes(r.status))
          throw new Error("session_busy");
        if (
          !validPath(input.path) ||
          (input.destination !== undefined && !validPath(input.destination))
        )
          throw new Error("invalid_path");
        send(await remote.call("file.manage", input));
        return;
      }
      if (op === "logs" && req.method === "GET") {
        const cursor = Number(url.searchParams.get("cursor") || 0);
        if (!Number.isSafeInteger(cursor) || cursor < 0)
          throw new Error("invalid_cursor");
        send(await remote.call("job.logs", { job: job(), cursor }));
        return;
      }
      if (op === "artifacts" && req.method === "GET") {
        send(await remote.call("job.artifacts", { job: job() }));
        return;
      }
      if (op === "cancel" && req.method === "POST") {
        send(await remote.call("job.cancel", { job: job() }));
        return;
      }
      if (op === "upload-begin" && req.method === "POST") {
        const input = await body(req, 8192);
        if (
          typeof input.name !== "string" ||
          !validPath(input.name) ||
          input.name.includes("/")
        )
          throw new Error("invalid_filename");
        const directory = input.directory ?? ".";
        if (directory !== "." && !validPath(directory))
          throw new Error("invalid_path");
        const listing = await remote.call("file.list", { path: directory });
        if (!listing.capabilities?.fileManagement)
          throw new Error("worker_update_required");
        const dest = (directory === "." ? "" : directory + "/") + input.name;
        const result = await remote.call("upload.begin", {
          path: dest,
          bytes: input.bytes,
          sha256: input.sha256,
        });
        uploads[result.id] = { session: id, path: dest, bytes: input.bytes };
        persist();
        send({ ...result, path: dest });
        return;
      }
      if (
        (op === "upload-chunk" || op === "upload-finish") &&
        req.method === "POST"
      ) {
        const input = await body(req);
        if (!uploads[input.upload] || uploads[input.upload].session !== id)
          throw new Error("upload_not_found");
        const result = await remote.call(
          op === "upload-chunk" ? "upload.chunk" : "upload.finish",
          op === "upload-chunk"
            ? {
                upload: input.upload,
                offset: input.offset,
                data: input.data,
                sha256: input.sha256,
              }
            : { upload: input.upload },
        );
        if (op === "upload-finish") {
          uploads[input.upload].complete = true;
          persist();
        }
        send(result);
        return;
      }
      if (op === "download" && req.method === "GET") {
        const file = url.searchParams.get("path");
        if (!validPath(file)) throw new Error("invalid_path");
        const operation = url.searchParams.has("job")
            ? "artifact.read"
            : "file.read",
          args = {
            path: file,
            ...(operation === "artifact.read" ? { job: job() } : {}),
          };
        const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/),
          start = range ? Number(range[1]) : 0,
          requestedEnd = range?.[2] ? Number(range[2]) : Infinity,
          preview = url.searchParams.get("preview") === "1";
        if (
          requestedEnd < start ||
          !Number.isSafeInteger(start) ||
          (requestedEnd !== Infinity && !Number.isSafeInteger(requestedEnd))
        )
          throw new Error("invalid_range");
        if (preview)
          res.setHeader(
            "Content-Security-Policy",
            "default-src 'none'; frame-ancestors 'self'; sandbox",
          );
        let offset = start,
          version,
          total,
          first = true;
        while (!res.destroyed) {
          const row = await remote.call(operation, {
            ...args,
            offset,
            size: Math.min(1024 * 1024, requestedEnd - offset + 1),
            ...(operation === "artifact.read" && version ? { version } : {}),
          });
          const bytes = Buffer.from(row.data, "base64");
          if (
            row.offset !== offset ||
            row.bytes !== bytes.length ||
            crypto.createHash("sha256").update(bytes).digest("hex") !==
              row.sha256 ||
            (version && row.version !== version)
          )
            throw new Error("download_integrity");
          version = row.version;
          total = row.total;
          if (first) {
            first = false;
            if (range && start >= total) {
              res.writeHead(416, { "Content-Range": "bytes */" + total });
              res.end();
              return;
            }
            const end = Math.min(requestedEnd, total - 1);
            res.setHeader(
              "Content-Type",
              preview ? fileType(file) : "application/octet-stream",
            );
            res.setHeader("Content-Length", end - start + 1);
            res.setHeader("Accept-Ranges", "bytes");
            if (range) {
              res.statusCode = 206;
              res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
            }
            res.setHeader(
              "Content-Disposition",
              (preview && fileType(file) !== "application/octet-stream"
                ? "inline"
                : "attachment") +
                "; filename*=UTF-8''" +
                encodeURIComponent(file.split("/").at(-1)),
            );
            if (version) res.setHeader("X-File-Version", version);
          }
          if (bytes.length && !res.write(bytes))
            await Promise.race([once(res, "drain"), once(res, "close")]);
          offset += bytes.length;
          if (offset === total || offset > requestedEnd) {
            res.end();
            return;
          }
          if (!bytes.length || offset > total)
            throw new Error("download_incomplete");
        }
        return;
      }
      throw new Error("method_not_allowed");
    } catch (e) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const error = safeError(e),
        status =
          /authentication|access_denied|jwt|jws|claim|signature|cloudflare_login/.test(
            error,
          ) || e.code?.startsWith("ERR_J")
            ? 401
            : /not_found/.test(error)
              ? 404
              : /busy/.test(error)
                ? 409
                : 400;
      json(req, res, status, {
        error: status === 401 ? "authentication_required" : error,
      });
    } finally {
      if (requestSession) {
        const remaining = sessionRequests.get(requestSession) - 1;
        if (remaining) sessionRequests.set(requestSession, remaining);
        else sessionRequests.delete(requestSession);
      }
    }
  });
  server.requestTimeout = 120000;
  server.headersTimeout = 15000;
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
  } catch (e) {
    await db.close();
    fs.unlinkSync(lock);
    if (dispatcher) {
      setGlobalDispatcher(previous);
      await dispatcher.close();
    }
    throw e;
  }
  setup.port = server.address().port;
  if (maintenance) setup.startMaintenance();
  return {
    server,
    store: db,
    port: server.address().port,
    key,
    async close() {
      setup.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await db.close();
      fs.rmSync(lock, { force: true });
      if (dispatcher) {
        setGlobalDispatcher(previous);
        await dispatcher.close();
      }
    },
  };
}
