import net from "node:net";
import { spawn } from "node:child_process";
const bridges = new Map();
export function wslArgs(distribution, ...command) {
  if (!/^StarportRuntime-[a-f0-9]{16}$/.test(distribution || ""))
    throw new Error("invalid_local_runtime");
  return [
    "--distribution",
    distribution,
    "--user",
    "root",
    "--exec",
    ...command,
  ];
}
export async function startLocalBridge(
  distribution,
  address,
  port,
  { spawnProcess = spawn, connect = net.createConnection } = {},
) {
  if (
    !/^\/tmp\/starport-egress-[a-f0-9]{32}\/proxy.sock$/.test(address) ||
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535
  )
    throw new Error("invalid_local_bridge");
  const key = distribution + ":" + address;
  if (bridges.has(key)) return bridges.get(key);
  const child = spawnProcess(
    "wsl.exe",
    wslArgs(
      distribution,
      "/usr/local/bin/python3",
      "-I",
      "/opt/starport-bootstrap/local_bridge.py",
      address,
    ),
    { stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true },
  );
  const peers = new Map();
  let pending = "",
    stopped = false,
    ready = false;
  let resolveReady, rejectReady;
  const started = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const handle = {
    process: child,
    close: () => {
      if (stopped) return;
      stopped = true;
      bridges.delete(key);
      clearTimeout(timer);
      for (const peer of peers.values()) peer.destroy();
      peers.clear();
      child.stdin.end();
      child.kill();
      if (!ready) rejectReady(new Error("local_egress_bridge_failed"));
    },
  };
  const timer = setTimeout(handle.close, 15000);
  const send = (frame) => {
    if (stopped) return;
    if (child.stdin.writableLength > 2 * 1024 * 1024) {
      handle.close();
      return;
    }
    if (!child.stdin.write(JSON.stringify(frame) + "\n"))
      for (const peer of peers.values()) peer.pause();
  };
  child.stdin.on("drain", () => {
    for (const peer of peers.values()) peer.resume();
  });
  child.stdin.on("error", handle.close);
  child.on("error", handle.close);
  child.on("close", handle.close);
  child.stderr.resume();
  child.stdout.on("data", (block) => {
    pending += block.toString("utf8");
    if (pending.length > 1024 * 1024) {
      handle.close();
      return;
    }
    let at;
    while ((at = pending.indexOf("\n")) >= 0 && !stopped) {
      const line = pending.slice(0, at);
      pending = pending.slice(at + 1);
      try {
        if (line.length > 32768) throw 0;
        const f = JSON.parse(line);
        if (f.type === "ready" && !ready) {
          ready = true;
          clearTimeout(timer);
          resolveReady(handle);
          continue;
        }
        if (!ready || !Number.isSafeInteger(f.id) || f.id < 1) throw 0;
        if (f.type === "open") {
          if (peers.has(f.id) || peers.size >= 32) throw 0;
          // Destination is an operator constant, never supplied by the task.
          const peer = connect({ host: "127.0.0.1", port });
          peers.set(f.id, peer);
          peer.setTimeout(120000, () => peer.destroy());
          peer.on("data", (data) => {
            for (let n = 0; n < data.length; n += 16384)
              send({
                type: "data",
                id: f.id,
                data: data.subarray(n, n + 16384).toString("base64"),
              });
          });
          peer.on("error", () => peer.destroy());
          peer.on("close", () => {
            peers.delete(f.id);
            send({ type: "close", id: f.id });
          });
        } else if (f.type === "close") {
          peers.get(f.id)?.destroy();
        } else if (f.type === "data") {
          if (
            typeof f.data !== "string" ||
            f.data.length > 21848 ||
            !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
              f.data,
            )
          )
            throw 0;
          const peer = peers.get(f.id),
            data = Buffer.from(f.data, "base64");
          if (data.length > 16384) throw 0;
          if (peer) {
            if (peer.writableLength > 1024 * 1024) peer.destroy();
            else peer.write(data);
          }
        } else throw 0;
      } catch {
        handle.close();
      }
    }
  });
  bridges.set(key, handle);
  return started;
}
export function closeLocalBridges(distributions) {
  for (const [key, bridge] of bridges)
    if (distributions.some((d) => key.startsWith(d + ":"))) bridge.close();
}
