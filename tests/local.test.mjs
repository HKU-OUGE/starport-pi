import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { Remote } from "../src/transport.mjs";
import { startLocalBridge, wslArgs } from "../src/local-bridge.mjs";
import { decodeWslList } from "../src/install-local.mjs";
import { PanelStore } from "../src/panel-store.mjs";

test("local project RPC is fixed to the owned worker and scoped workspace", async () => {
  const distribution = "StarportRuntime-" + "a".repeat(16),
    calls = [];
  const remote = new Remote(
    {
      activeServer: "local",
      workspace: "b".repeat(32),
      servers: { local: { mode: "wsl", distribution } },
    },
    "/unused",
    {
      call: async (...args) => {
        calls.push(args);
        return Buffer.from('{"ok":true,"result":{"saved":true}}');
      },
    },
  );
  await remote.call("file.write", { path: "demo.py", content: "data" });
  assert.equal(calls[0][0], "wsl.exe");
  assert.deepEqual(calls[0][1], [
    "--distribution",
    distribution,
    "--user",
    "root",
    "--exec",
    "/usr/local/bin/python3",
    "-I",
    "/opt/starport/worker/worker.py",
    "rpc",
  ]);
  assert.equal(JSON.parse(calls[0][2]).workspace, "b".repeat(32));
  assert.throws(() => wslArgs("Ubuntu", "bash"), /invalid_local_runtime/);
  assert.deepEqual(
    decodeWslList(
      Buffer.from("\uFEFFUbuntu\r\n" + distribution + "\r\n", "utf16le"),
    ),
    ["Ubuntu", distribution],
  );
});

test("conversation-only creation works without servers and cannot access a filesystem", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "starport-chat-"));
  const store = new PanelStore(root, {
    remoteFactory: () => {
      throw new Error("unexpected_execution");
    },
  });
  try {
    const row = await store.create({ title: "Conversation" });
    assert.equal(row.mode, "chat");
    assert.deepEqual(row.jobs, []);
    assert.equal(store.config(row).mode, "chat");
    await assert.rejects(
      () => store.remote(row).call("file.list"),
      /no_execution_environment/,
    );
    await assert.rejects(
      () => store.create({ title: "No runtime", server: "local" }),
      /server_not_configured/,
    );
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test(
  "real stdio bridge streams bytes only to configured loopback proxy and closes on loss",
  { skip: process.platform !== "linux", timeout: 20000 },
  async () => {
    const dir =
        "/tmp/starport-egress-" + crypto.randomBytes(16).toString("hex"),
      address = dir + "/proxy.sock";
    const proxy = net.createServer((peer) => peer.pipe(peer));
    await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
    const port = proxy.address().port,
      connections = [];
    let bridge,
      client,
      closed = false;
    try {
      bridge = await startLocalBridge(
        "StarportRuntime-" + crypto.randomBytes(8).toString("hex"),
        address,
        port,
        {
          spawnProcess: (_program, args, options) =>
            spawn(
              "python3",
              [
                "-I",
                new URL("../server/local_bridge.py", import.meta.url).pathname,
                args.at(-1),
              ],
              options,
            ),
          connect: (options) => {
            connections.push(options);
            return net.createConnection(options);
          },
        },
      );
      client = net.createConnection(address);
      await new Promise((r, j) => {
        client.once("connect", r);
        client.once("error", j);
      });
      const data = crypto.randomBytes(2 * 1024 * 1024),
        blocks = [];
      let received = 0;
      const done = new Promise((r, j) => {
        client.on("data", (b) => {
          blocks.push(b);
          received += b.length;
          if (received === data.length) r();
        });
        client.once("error", j);
      });
      client.write(data);
      await done;
      assert.deepEqual(Buffer.concat(blocks), data);
      assert.deepEqual(connections, [{ host: "127.0.0.1", port }]);
      const lost = new Promise((r) =>
        client.once("close", () => {
          closed = true;
          r();
        }),
      );
      bridge.close();
      await lost;
      assert.equal(closed, true);
    } finally {
      client?.destroy();
      bridge?.close();
      await new Promise((r) => proxy.close(r));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
