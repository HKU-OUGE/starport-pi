import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { load, save, writePrivate } from "../src/config.mjs";
import { Addons } from "../src/addons.mjs";
import {
  collectProfile,
  exportProfile,
  decodeProfile,
  importProfile,
  profileSummary,
} from "../src/profile-transfer.mjs";

test("encrypted extensions import without executing or enabling entries", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "starport-addons-export-")),
    source = path.join(dir, "source"),
    target = path.join(dir, "target");
  try {
    const c = load(source);
    c.features = { webSearch: true, cache: "1h" };
    save(c, source);
    const a = new Addons(source);
    a.save("skills", {
      id: "review",
      label: "Review",
      content: "Cite sources.",
      enabled: true,
    });
    a.save("mcp", {
      id: "public",
      label: "Public",
      url: "https://mcp.example.com/mcp",
      tools: ["search"],
      token: "example-private-mcp-token",
      enabled: true,
    });
    a.save("plugins", {
      id: "bundle",
      label: "Bundle",
      description: "Review",
      skills: ["review"],
      mcp: ["public"],
      enabled: true,
    });
    const bundle = await exportProfile(source, {
      includeSecrets: true,
      password: "example-strong-password",
    });
    assert.ok(!JSON.stringify(bundle).includes("example-private-mcp-token"));
    await importProfile(target, bundle, "example-strong-password");
    const imported = new Addons(target);
    assert.equal(imported.read().mcp[0].token, "example-private-mcp-token");
    for (const list of Object.values(imported.read()))
      assert.ok(list.every((x) => !x.enabled));
    assert.equal(load(target).features.cache, "1h");
    assert.deepEqual(load(target).features.plugins, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

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
      instanceId: "dsw-" + "example1234567890",
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

test("repair changes only unused DSW identities and retains credentials and other configuration", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "starport-repair-"));
  try {
    const c = load(root),
      cred = path.join(root, "credential-file");
    fs.writeFileSync(
      cred,
      "accesskeyid = 'example-key'\naccesskeysecret = 'example-secret'\nregionid = 'old-region'\nststoken = ''\n",
    );
    c.servers.alpha = {
      mode: "dsw",
      instanceId: "dsw-proxy",
      region: "old-region",
      user: "root",
      proxyClient: "proxyclient",
      credentialsFile: cred,
      identityFile: "operator-key",
      initialized: false,
      budget: { cpus: 2, memoryGiB: 4, gpus: [] },
    };
    c.model = "claude-opus-5-5";
    c.proxy.selected = "unchanged";
    save(c, root);
    writePrivate(path.join(root, "secrets.json"), {
      anthropicApiKey: "keep-this-key",
    });
    writePrivate(path.join(root, "cloudflare", "receipt.json"), {
      tunnel: "keep-this-tunnel",
    });
    const profile = {
      format: "starport-pi-profile",
      version: 1,
      network: { subscriptions: [] },
      servers: [
        {
          name: "alpha",
          mode: "dsw",
          instanceId: "dsw-" + "example1234567890",
          region: "new-region",
          privateKey: "DO NOT IMPORT",
          credentials: { accesskeysecret: "DO NOT IMPORT" },
        },
      ],
    };
    const { updateUnverifiedConnections } = await import(
      "../src/profile-transfer.mjs"
    );
    const done = await updateUnverifiedConnections(root, profile, "");
    assert.deepEqual(done.updated, ["alpha"]);
    const after = load(root);
    assert.equal(after.servers.alpha.instanceId, profile.servers[0].instanceId);
    assert.equal(after.servers.alpha.region, "new-region");
    assert.equal(after.servers.alpha.identityFile, "operator-key");
    assert.equal(after.servers.alpha.initialized, false);
    assert.equal(after.proxy.selected, "unchanged");
    assert.equal(after.model, c.model);
    const credentials = fs.readFileSync(
      after.servers.alpha.credentialsFile,
      "utf8",
    );
    assert.ok(credentials.includes("example-secret"));
    assert.ok(credentials.includes("new-region"));
    assert.ok(!credentials.includes("DO NOT IMPORT"));
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(root, "secrets.json")))
        .anthropicApiKey,
      "keep-this-key",
    );
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(root, "cloudflare", "receipt.json")))
        .tunnel,
      "keep-this-tunnel",
    );
    assert.equal(
      (await updateUnverifiedConnections(root, profile, "")).unchanged,
      true,
    );
    const before = fs.readFileSync(path.join(root, "config.json"), "utf8");
    for (const protection of [
      { initialized: true },
      { installStarted: true },
      { knownHostsFile: "keep-host-trust" },
    ]) {
      const next = structuredClone(after);
      Object.assign(next.servers.alpha, protection);
      save(next, root);
      await assert.rejects(
        () =>
          updateUnverifiedConnections(
            root,
            {
              ...profile,
              servers: [
                {
                  ...profile.servers[0],
                  instanceId: "dsw-" + "different12345678",
                },
              ],
            },
            "",
          ),
        /requires_unused/,
      );
      assert.deepEqual(load(root), next);
    }
    fs.writeFileSync(path.join(root, "config.json"), before);
    writePrivate(path.join(root, "panel", "sessions.json"), [
      { server: "alpha", jobs: [] },
    ]);
    await assert.rejects(
      () =>
        updateUnverifiedConnections(
          root,
          {
            ...profile,
            servers: [{ ...profile.servers[0], region: "another-region" }],
          },
          "",
        ),
      /requires_unused/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
