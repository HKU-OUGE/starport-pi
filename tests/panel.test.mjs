import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { generateKeyPair, SignJWT, exportJWK, createLocalJWKSet } from "jose";
import { verifyAccess } from "../src/access.mjs";
import { startPanel } from "../src/panel.mjs";
import { load, save } from "../src/config.mjs";
import { PanelStore } from "../src/panel-store.mjs";
import { parseSshCommand, verifyWorker } from "../src/setup.mjs";
import { findKeys, fingerprint } from "../src/keys.mjs";
import { processCall, sshArgs } from "../src/transport.mjs";

test("Access JWT verifies signature, audience, issuer, expiry and exact email", async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256"),
    jwk = await exportJWK(publicKey);
  jwk.kid = "test";
  const keySet = createLocalJWKSet({ keys: [jwk] });
  const config = {
    issuer: "https://team.example.cloudflareaccess.com",
    audience: "panel-a",
    allowedEmails: ["owner@example.invalid"],
  };
  const token = async (changes = {}) =>
    new SignJWT({ email: "owner@example.invalid", ...changes })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setSubject("test-user")
      .setIssuedAt()
      .setIssuer(changes.iss || config.issuer)
      .setAudience(changes.aud || "panel-a")
      .setExpirationTime(changes.exp || "5m")
      .sign(privateKey);
  assert.equal(
    await verifyAccess(await token(), config, { keySet }),
    "test-user",
  );
  for (const change of [
    { email: "other@example.invalid" },
    { aud: "panel-b" },
    { iss: "https://another.example.invalid" },
    { exp: 1 },
  ])
    await assert.rejects(() =>
      token(change).then((t) => verifyAccess(t, config, { keySet })),
    );
  const good = await token();
  await assert.rejects(() =>
    verifyAccess(good.slice(0, -20) + "a".repeat(20), config, { keySet }),
  );
});

function fakeRemote() {
  let seq = 0;
  const files = new Map(),
    uploads = new Map();
  return {
    call: async (op, p = {}) => {
      if (op === "health")
        return {
          ready: true,
          cpus: 4,
          memory_gib: 8,
          gpus: 0,
          egress_ready: true,
          egress_socket: "/private/operator/socket",
        };
      if (op === "workspace.create")
        return { id: String(++seq).padStart(32, "0") };
      if (op === "file.list")
        return {
          entries: [...files].map(([name, b]) => ({
            name,
            kind: "file",
            bytes: b.length,
          })),
        };
      if (op === "upload.begin") {
        const id = String(++seq).padStart(32, "0");
        uploads.set(id, { ...p, data: Buffer.alloc(0) });
        return { id, offset: 0 };
      }
      if (op === "upload.chunk") {
        const u = uploads.get(p.upload),
          b = Buffer.from(p.data, "base64");
        assert.equal(
          crypto.createHash("sha256").update(b).digest("hex"),
          p.sha256,
        );
        if (p.offset === u.data.length) u.data = Buffer.concat([u.data, b]);
        return { offset: u.data.length };
      }
      if (op === "upload.finish") {
        const u = uploads.get(p.upload);
        assert.equal(
          crypto.createHash("sha256").update(u.data).digest("hex"),
          u.sha256,
        );
        files.set(u.path, u.data);
        return { path: u.path, bytes: u.data.length, sha256: u.sha256 };
      }
      if (op === "file.read") {
        const all = files.get(p.path) || Buffer.from("result"),
          data = all.subarray(p.offset, p.offset + p.size);
        return {
          offset: p.offset,
          bytes: data.length,
          total: all.length,
          version: "fixed",
          data: data.toString("base64"),
          sha256: crypto.createHash("sha256").update(data).digest("hex"),
        };
      }
      throw new Error("unsupported_operation");
    },
  };
}

test("HTTP panel rejects unauthenticated and cross-origin writes; streams verified remote files", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "starport-panel-"));
  const config = load(root);
  config.servers.alpha = {
    mode: "ssh",
    host: "worker.example.invalid",
    initialized: true,
  };
  save(config, root);
  const remote = fakeRemote(),
    store = new PanelStore(root, { remoteFactory: () => remote });
  let app;
  try {
    app = await startPanel(root, {
      port: 0,
      store,
      useModelProxy: false,
      maintenance: false,
    });
    const base = "http://127.0.0.1:" + app.port;
    assert.equal((await fetch(base + "/api/bootstrap")).status, 401);
    const sign = await fetch(base + "/api/login", {
      method: "POST",
      headers: { Origin: base, "Content-Type": "application/json" },
      body: JSON.stringify({ key: app.key }),
    });
    assert.equal(sign.status, 200);
    const cookie = sign.headers.get("set-cookie").split(";")[0];
    const head = {
      Cookie: cookie,
      Origin: base,
      "Content-Type": "application/json",
    };
    const boot = await (
      await fetch(base + "/api/bootstrap", { headers: head })
    ).json();
    assert.ok(!JSON.stringify(boot).includes("/private/operator"));
    head["X-Starport-CSRF"] = boot.csrf;
    const post = async (route, body, headers = head) =>
      fetch(base + "/api/" + route, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    assert.equal(
      (
        await post(
          "sessions",
          { title: "Project Atlas", server: "alpha" },
          { ...head, Origin: "https://untrusted.example.invalid" },
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await post(
          "sessions",
          { title: "Project Atlas", server: "alpha" },
          { ...head, "X-Starport-CSRF": "invalid" },
        )
      ).status,
      400,
    );
    const row = await (
        await post("sessions", { title: "Project Atlas", server: "alpha" })
      ).json(),
      id = row.id;
    assert.equal(id.length, 32);
    const data = crypto.randomBytes(1500000),
      sha256 = crypto.createHash("sha256").update(data).digest("hex");
    const grant = await (
      await post("sessions/" + id + "/upload-begin", {
        name: "sample.bin",
        bytes: data.length,
        sha256,
      })
    ).json();
    for (let offset = 0; offset < data.length; offset += 1000000) {
      const b = data.subarray(offset, offset + 1000000);
      const r = await post("sessions/" + id + "/upload-chunk", {
        upload: grant.id,
        offset,
        data: b.toString("base64"),
        sha256: crypto.createHash("sha256").update(b).digest("hex"),
      });
      assert.equal(r.status, 200);
    }
    const other = await (
      await post("sessions", { title: "Other", server: "alpha" })
    ).json();
    assert.equal(
      (
        await post("sessions/" + other.id + "/upload-finish", {
          upload: grant.id,
        })
      ).status,
      404,
    );
    assert.equal(
      (await post("sessions/" + id + "/upload-finish", { upload: grant.id }))
        .status,
      200,
    );
    const download = await fetch(
      base +
        "/api/sessions/" +
        id +
        "/download?path=" +
        encodeURIComponent(grant.path),
      { headers: head },
    );
    assert.equal(download.status, 200);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), data);
    const part = await fetch(
      base +
        "/api/sessions/" +
        id +
        "/download?path=" +
        encodeURIComponent(grant.path),
      { headers: { ...head, Range: "bytes=23-88" } },
    );
    assert.equal(part.status, 206);
    assert.deepEqual(
      Buffer.from(await part.arrayBuffer()),
      data.subarray(23, 89),
    );
    const a = await (
      await post("sessions/" + id + "/attach-begin", {
        name: "report.txt",
        bytes: 6,
        sha256: crypto.createHash("sha256").update("report").digest("hex"),
      })
    ).json();
    const chunk = {
      upload: a.id,
      offset: 0,
      data: Buffer.from("report").toString("base64"),
      sha256: crypto.createHash("sha256").update("report").digest("hex"),
    };
    assert.equal(
      (await post("sessions/" + id + "/attach-chunk", chunk)).status,
      200,
    );
    assert.equal(
      (await post("sessions/" + id + "/attach-finish", { upload: a.id }))
        .status,
      200,
    );
    const ownedUrl = base + "/api/sessions/" + id + "/attachment?id=" + a.id;
    assert.equal((await fetch(ownedUrl)).status, 401);
    assert.equal(
      (
        await fetch(
          base + "/api/sessions/" + other.id + "/attachment?id=" + a.id,
          { headers: head },
        )
      ).status,
      404,
    );
    const attached = await fetch(ownedUrl, {
      headers: { ...head, Range: "bytes=1-3" },
    });
    assert.equal(attached.status, 206);
    assert.equal(await attached.text(), "epo");
    assert.equal(
      (await post("sessions/" + other.id + "/attach-finish", { upload: a.id }))
        .status,
      404,
    );
    assert.equal(
      (
        await fetch(base + "/api/sessions/" + id + "/download?path=../secret", {
          headers: head,
        })
      ).status,
      400,
    );
    assert.equal(
      (await post("setup", { action: "network-apply", node: "invalid" }))
        .status,
      200,
    ); // operation is asynchronous
    await app.store.refresh();
  } finally {
    await app?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("SSH command input cannot execute local commands or proxy options", () => {
  assert.deepEqual(
    parseSshCommand('ssh -i "private key" -p 2222 worker@node.example.invalid'),
    { mode: "ssh", host: "worker@node.example.invalid", port: 2222 },
  );
  for (const s of [
    "ssh a; id",
    "ssh a bash",
    "ssh -o ProxyCommand=evil a",
    "ssh $(id)",
    "curl https://example.com",
    "ssh -p 0 a",
  ])
    assert.throws(() => parseSshCommand(s));
});
test("private known-host paths survive native OpenSSH parsing with spaces", async () => {
  const file = path.join(os.tmpdir(), "starport profile", "known_hosts");
  const args = sshArgs(
    "alpha",
    { mode: "ssh", host: "worker.example.invalid", knownHostsFile: file },
    os.tmpdir(),
  );
  const output = (await processCall("ssh", ["-G", ...args], "")).toString();
  const line = output
    .split("\n")
    .find((x) => x.startsWith("userknownhostsfile "));
  assert.ok(line.includes(file.replaceAll("\\", "/")), line);
});
test("server activation requires a successful isolation probe and confirmed resource release", async () => {
  let status = { status: "completed", exit_code: 0, released: true };
  const remote = {
    call: async (op) =>
      op === "job.submit"
        ? { id: "a".repeat(32) }
        : op === "job.status"
          ? status
          : {
              text: JSON.stringify({
                passed: true,
                direct_network_blocked: true,
                machine_id_empty: true,
              }),
            },
  };
  assert.equal(
    (await verifyWorker(remote, { delay: async () => {} })).verified,
    true,
  );
  for (const bad of [
    { ...status, released: false },
    { ...status, status: "failed" },
    { ...status, exit_code: 1 },
  ]) {
    status = bad;
    await assert.rejects(
      () => verifyWorker(remote, { delay: async () => {} }),
      /isolation_probe_failed/,
    );
  }
});
test("private-key search proves the matching public key and skips links", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "starport keys "));
  try {
    const file = path.join(dir, "identity");
    await processCall(
      "ssh-keygen",
      ["-t", "ed25519", "-N", "", "-C", "test", "-f", file],
      "",
    );
    const pub = fs.readFileSync(file + ".pub", "utf8");
    const found = await findKeys({ directory: dir, publicKey: pub });
    assert.equal(found.length, 1);
    assert.equal(found[0].fingerprint, fingerprint(pub));
    const elsewhere = path.join(dir, "different");
    await processCall(
      "ssh-keygen",
      ["-t", "ed25519", "-N", "", "-f", elsewhere],
      "",
    );
    assert.equal(
      (await findKeys({ directory: dir, publicKey: pub })).filter((k) => k.file)
        .length,
      1,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("imported DSW scan creates its private directory and reports a safe cloud failure", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "starport-dsw-scan-"));
  try {
    const { Setup } = await import("../src/setup.mjs");
    const { writePrivate } = await import("../src/config.mjs");
    const c = load(root);
    c.servers.alpha = {
      mode: "dsw",
      instanceId: "dsw-" + "example1234567890",
      region: "example-region",
      user: "root",
      proxyClient: "proxyclient",
      credentialsFile: "credentials",
      identityFile: "key",
      initialized: false,
    };
    save(c, root);
    const setup = new Setup(root, {
      tool: async () => "proxyclient",
      execute: async (program, args) => {
        assert.equal(program, "ssh");
        assert.ok(args.some((x) => x.includes("host-key-scan")));
        const directory = path.join(root, "connections", "alpha");
        assert.ok(fs.existsSync(directory));
        writePrivate(path.join(directory, "proxy-status.json"), {
          error: "dsw_instance_not_found_check_id_and_region",
        });
        throw new Error("server_connection_failed");
      },
    });
    await setup.dispatch("server-scan", { name: "alpha" });
    await setup.pending;
    assert.equal(setup.operations[0].status, "failed");
    assert.equal(
      setup.operations[0].error,
      "dsw_instance_not_found_check_id_and_region",
    );
    assert.equal(
      fs.existsSync(path.join(root, "connections", "alpha", "known_hosts")),
      false,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
