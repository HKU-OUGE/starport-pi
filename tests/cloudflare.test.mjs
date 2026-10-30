import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Enrollment } from "../src/cloudflare.mjs";
import { startPanel } from "../src/panel.mjs";
import { writePrivate } from "../src/config.mjs";
class FakeCloudflare {
  constructor() {
    this.rows = new Map();
    this.events = [];
    this.unknown = false;
  }
  async list(route) {
    if (route.startsWith("/zones?"))
      return [{ id: "zone", name: "example.com", account: { id: "account" } }];
    if (route.endsWith("/identity_providers")) return [{ id: "otp" }];
    if (route.match(/\/apps\/[^/]+\/policies$/))
      return [...this.rows.values()].filter((x) => x.decision === "allow");
    const base = route.split("?")[0];
    return [...this.rows]
      .filter(
        ([k]) =>
          k.startsWith(base + "/") && !k.slice(base.length + 1).includes("/"),
      )
      .map(([, v]) => v);
  }
  async call(method, route, body) {
    this.events.push([method, route]);
    if (route.endsWith("/organizations"))
      return { result: { auth_domain: "test-team.cloudflareaccess.com" } };
    if (route.endsWith("/token")) return { result: "example-connector-token" };
    if (method === "POST") {
      const value = {
        ...body,
        id: "id" + this.rows.size,
        ...(body.type === "self_hosted" ? { aud: "example-audience" } : {}),
      };
      this.rows.set(route + "/" + value.id, value);
      if (this.unknown) {
        this.unknown = false;
        throw new Error("cloudflare_outcome_unknown");
      }
      return { result: value };
    }
    if (method === "GET") {
      const row = this.rows.get(route);
      if (!row) throw new Error("cloudflare_http_404");
      return { result: row };
    }
    if (method === "DELETE") {
      this.rows.delete(route);
      return { result: {} };
    }
    return { result: {} };
  }
}
const store = {
  health: {},
  epoch: "test",
  list: () => [],
  close: async () => {},
};
test("Cloudflare provisioning protects origin before DNS, resumes unknown creation without duplicates and rolls back owned resources", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "starport-access-"));
  let panel;
  try {
    panel = await startPanel(root, { port: 0, store, useModelProxy: false, maintenance: false });
    const api = new FakeCloudflare(),
      flow = new Enrollment(api, root);
    const plan = await flow.plan({
      zone: "example.com",
      prefix: "console",
      port: panel.port,
      allowedEmails: ["owner@example.invalid"],
    });
    assert.match(plan.hostname, /^console-[a-f0-9]+\.example.com$/);
    api.unknown = true;
    await assert.rejects(() => flow.apply(), /outcome_unknown/);
    assert.equal((await flow.status()).pending, null);
    const done = await flow.apply();
    assert.equal(done.stage, "configured");
    const creates = api.events.filter(([m]) => m === "POST");
    assert.equal(creates.length, 4);
    assert.match(creates[0][1], /access\/policies$/);
    assert.match(creates.at(-1)[1], /dns_records$/);
    assert.equal(
      (await fetch("http://127.0.0.1:" + panel.port + "/api/bootstrap")).status,
      401,
    );
    assert.ok(
      !fs
        .readFileSync(path.join(root, "cloudflare", "receipt.json"), "utf8")
        .includes("example-connector-token"),
    );
    await flow.apply();
    assert.equal(api.events.filter(([m]) => m === "POST").length, 4);
    await flow.rollback();
    assert.equal(api.rows.size, 0);
    assert.equal(flow.read().stage, "removed");
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(root, "access.json"), "utf8")).mode,
      "cloudflare",
    );
  } finally {
    await panel?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("existing origin Access profile is never overwritten by a different enrollment", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "starport-access-"));
  try {
    writePrivate(path.join(root, "access.json"), { audience: "another-app" });
    const flow = new Enrollment(new FakeCloudflare(), root);
    await flow.plan({
      zone: "example.com",
      port: 18900,
      allowedEmails: ["owner@example.invalid"],
    });
    await assert.rejects(() => flow.apply(), /another_access_application/);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(root, "access.json"), "utf8"))
        .audience,
      "another-app",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
