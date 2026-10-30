import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { load, save, writePrivate } from "../src/config.mjs";
import {
  collectProfile,
  exportProfile,
  decodeProfile,
  importProfile,
  profileSummary,
} from "../src/profile-transfer.mjs";

test("encrypted profiles round-trip on fresh machines without runtime identities or operator paths", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "starport-transfer-")),
    source = path.join(dir, "source"),
    target = path.join(dir, "target");
  try {
    const c = load(source),
      key = path.join(source, "identity"),
      credentials = path.join(source, "credential-file");
    fs.writeFileSync(
      key,
      crypto
        .generateKeyPairSync("ed25519")
        .privateKey.export({ type: "pkcs8", format: "pem" }),
    );
    fs.writeFileSync(
      credentials,
      "accesskeyid = 'example-key-id'\naccesskeysecret = 'example-key-secret'\nregionid = 'example-region'\nststoken = ''\n",
    );
    c.servers.alpha = {
      mode: "dsw",
      instanceId: "dsw-example",
      region: "example-region",
      user: "root",
      proxyClient: path.join(source, "proxyclient"),
      credentialsFile: credentials,
      identityFile: key,
      initialized: true,
      knownHostsFile: path.join(source, "hosts"),
      budget: { cpus: 4, memoryGiB: 8, gpus: [] },
    };
    c.servers.local = {
      mode: "wsl",
      distribution: "StarportRuntime-" + "a".repeat(16),
      budget: { cpus: 2, memoryGiB: 4, gpus: [] },
    };
    c.subscriptions = [{ id: "sub-" + "a".repeat(12), label: "Example" }];
    c.proxy.selected = c.subscriptions[0].id + ":0";
    save(c, source);
    writePrivate(
      path.join(source, "subscriptions", c.subscriptions[0].id + ".json"),
      {
        url: "https://example.com/subscription",
        nodes: [
          {
            type: "ss",
            name: "Example node",
            server: "example.com",
            port: 443,
            cipher: "aes-128-gcm",
            password: "example-password",
          },
        ],
      },
    );
    writePrivate(path.join(source, "secrets.json"), {
      anthropicApiKey: "sk-ant-" + "example-test-key",
    });
    writePrivate(path.join(source, "cloudflare", "enrollment.json"), {
      zone: "example.com",
      prefix: "console",
      allowedEmails: ["owner@example.invalid"],
      tokenFile: "api-token",
    });
    fs.writeFileSync(
      path.join(source, "cloudflare", "api-token"),
      "example-api-token\n",
    );
    writePrivate(path.join(source, "cloudflare", "receipt.json"), {
      tunnelToken: "must-not-export",
      audience: "must-not-export",
    });
    const plain = collectProfile(source, { includeSecrets: true }),
      text = JSON.stringify(plain);
    assert.ok(!text.includes(source));
    assert.ok(!text.includes("must-not-export"));
    assert.ok(!text.includes("StarportRuntime-"));
    assert.equal(profileSummary(plain).cloudflareTokenIncluded, true);
    const password = crypto.randomBytes(24).toString("hex");
    const bundle = await exportProfile(source, {
      includeSecrets: true,
      password,
    });
    assert.ok(!JSON.stringify(bundle).includes("example-password"));
    await assert.rejects(
      () => decodeProfile(bundle, "wrong-password"),
      /integrity/,
    );
    await assert.rejects(
      () =>
        decodeProfile(
          { ...bundle, tag: Buffer.alloc(16).toString("base64") },
          password,
        ),
      /integrity/,
    );
    const result = await importProfile(target, bundle, password),
      restored = load(target);
    assert.equal(result.imported, true);
    assert.equal(restored.servers.alpha.initialized, false);
    assert.equal(restored.servers.alpha.knownHostsFile, undefined);
    assert.ok(restored.servers.alpha.identityFile.startsWith(target));
    assert.equal(restored.servers.local, undefined);
    assert.equal(restored.proxy.selected, c.proxy.selected);
    assert.equal(
      fs.readFileSync(restored.servers.alpha.identityFile, "utf8"),
      fs.readFileSync(key, "utf8"),
    );
    assert.equal(
      fs.existsSync(path.join(target, "cloudflare", "receipt.json")),
      false,
    );
    await assert.rejects(
      () => importProfile(target, bundle, password),
      /empty_profile/,
    );
    const publicText = JSON.stringify(collectProfile(source));
    for (const secret of [
      "example-password",
      "example-key-secret",
      "example-api-token",
      "PRIVATE KEY",
      "example-test-key",
    ])
      assert.ok(!publicText.includes(secret));
    const badTarget = path.join(dir, "invalid");
    await assert.rejects(() =>
      importProfile(
        badTarget,
        { ...plain, cloudflare: { ...plain.cloudflare, zone: "bad;command" } },
        "",
      ),
    );
    assert.equal(fs.existsSync(path.join(badTarget, "secrets.json")), false);
    assert.deepEqual(load(badTarget).servers, {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
