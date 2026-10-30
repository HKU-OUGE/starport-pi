import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { generateKeyPair, SignJWT, exportJWK, createLocalJWKSet } from "jose";
import { startPanel } from "../src/panel.mjs";
import { writePrivate } from "../src/config.mjs";
import { requestPolicy } from "../src/access.mjs";

const access = {
  mode: "cloudflare",
  hostname: "console-test.example.com",
  issuer: "https://test-team.cloudflareaccess.com",
  audience: "test-panel",
  allowedEmails: ["owner@example.invalid"],
};
const store = { health: {}, epoch: "test", list: () => [], close: async () => {} };
function request(port, route, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: "/api/" + route, method, headers }, res => {
      const parts = [];
      res.on("data", b => parts.push(b));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(Buffer.concat(parts)) }));
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
async function signIn(panel) {
  const base = "http://127.0.0.1:" + panel.port;
  const r = await request(panel.port, "login", { method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: { key: panel.key } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const headers = { Origin: base, "Content-Type": "application/json", Cookie: r.headers["set-cookie"][0].split(";")[0] };
  const boot = await request(panel.port, "bootstrap", { headers });
  assert.equal(boot.status, 200);
  headers["X-Starport-CSRF"] = boot.data.csrf;
  return headers;
}

test("local policy requires both a loopback peer and the exact local Host", () => {
  for (const host of ["127.0.0.1:18900", "localhost:18900"])
    assert.equal(requestPolicy({ headers: { host }, socket: { remoteAddress: "127.0.0.1" } }, access, 18900).origin, "http://" + host);
  assert.throws(() => requestPolicy({ headers: { host: "127.0.0.1:18900" }, socket: { remoteAddress: "192.0.2.1" } }, access, 18900), /local_access_denied/);
  assert.throws(() => requestPolicy({ headers: { host: "127.0.0.1:18901" }, socket: { remoteAddress: "127.0.0.1" } }, access, 18900), /host_not_allowed/);
});

test("enabling Access keeps an existing local operator session and restart recovery usable", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "starport-origin-"));
  let panel;
  try {
    panel = await startPanel(root, { port: 0, store, useModelProxy: false, maintenance: false });
    const headers = await signIn(panel);
    writePrivate(path.join(root, "access.json"), access);
    const state = await request(panel.port, "setup", { method: "POST", headers, body: { action: "state" } });
    assert.equal(state.status, 200, JSON.stringify(state.data));
    const boot = await request(panel.port, "bootstrap", { headers });
    assert.equal(boot.status, 200);
    assert.equal(boot.data.mode, "local");
    assert.equal(boot.data.csrf, headers["X-Starport-CSRF"]);
    await panel.close(); panel = null;
    panel = await startPanel(root, { port: 0, store, useModelProxy: false, maintenance: false });
    await signIn(panel);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "access.json"))), access);
    assert.equal((await request(panel.port, "bootstrap", { headers: { Host: access.hostname } })).status, 401);
  } finally { await panel?.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("public-host requests require valid Access JWTs and cannot borrow loopback authentication", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "starport-public-origin-"));
  let panel;
  try {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey); jwk.kid = "test";
    const keySet = createLocalJWKSet({ keys: [jwk] });
    const token = (audience = access.audience, email = access.allowedEmails[0]) => new SignJWT({ email }).setProtectedHeader({ alg: "RS256", kid: "test" }).setIssuedAt().setExpirationTime("5m").setSubject("test-owner").setIssuer(access.issuer).setAudience(audience).sign(privateKey);
    panel = await startPanel(root, { port: 0, store, useModelProxy: false, maintenance: false, authOptions: { keySet } });
    const local = await signIn(panel);
    writePrivate(path.join(root, "access.json"), access);
    const remote = { ...local, Host: access.hostname, Origin: "https://" + access.hostname, "X-Starport-Admin": panel.key };
    assert.equal((await request(panel.port, "bootstrap", { headers: remote })).status, 401);
    assert.equal((await request(panel.port, "setup", { method: "POST", headers: remote, body: { action: "state" } })).status, 401);
    assert.equal((await request(panel.port, "login", { method: "POST", headers: remote, body: { key: panel.key } })).status, 401);
    for (const jwt of ["invalid", await token("other-panel"), await token(access.audience, "other@example.invalid")])
      assert.equal((await request(panel.port, "bootstrap", { headers: { ...remote, "Cf-Access-Jwt-Assertion": jwt } })).status, 401);
    remote["Cf-Access-Jwt-Assertion"] = await token();
    const boot = await request(panel.port, "bootstrap", { headers: remote });
    assert.equal(boot.status, 200); assert.equal(boot.data.mode, "cloudflare");
    remote["X-Starport-CSRF"] = boot.data.csrf;
    assert.equal((await request(panel.port, "setup", { method: "POST", headers: remote, body: { action: "state" } })).status, 200);
    const noAdmin = { ...remote }; delete noAdmin["X-Starport-Admin"];
    const denied = await request(panel.port, "setup", { method: "POST", headers: noAdmin, body: { action: "state" } });
    assert.equal(denied.data.error, "operator_key_required");
    for (const origin of [local.Origin, "null", "https://another.example.com", undefined]) {
      const headers = { ...remote, Origin: origin }; if (origin === undefined) delete headers.Origin;
      assert.equal((await request(panel.port, "setup", { method: "POST", headers, body: { action: "state" } })).data.error, "origin_not_allowed");
    }
    for (const forwarded of [{ Forwarded: "for=192.0.2.1" }, { "X-Forwarded-For": "127.0.0.1" }, { "X-Forwarded-Host": access.hostname }, { "Cf-Connecting-IP": "192.0.2.1" }, { "Cf-Access-Jwt-Assertion": remote["Cf-Access-Jwt-Assertion"] }])
      assert.equal((await request(panel.port, "bootstrap", { headers: { ...local, ...forwarded } })).status, 401);
    const cross = await request(panel.port, "setup", { method: "POST", headers: { ...local, Origin: "https://untrusted.example.invalid" }, body: { action: "state" } });
    assert.equal(cross.data.error, "origin_not_allowed");
    assert.equal((await request(panel.port, "bootstrap", { headers: { Host: "untrusted.example.invalid" } })).data.error, "host_not_allowed");
  } finally { await panel?.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
