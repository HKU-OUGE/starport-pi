import fs from "node:fs";
import crypto from "node:crypto";
import { processCall, sshArgs, Remote } from "./transport.mjs";
import { wslArgs } from "./local-bridge.mjs";

export async function updateWorker(
  config,
  root,
  { execute = processCall } = {},
) {
  const name = config.activeServer,
    server = config.servers[name];
  if (!server || server.initialized !== true)
    throw new Error("verified_server_required");
  const source = fs.readFileSync(
    new URL("../server/worker.py", import.meta.url),
  );
  const hash = crypto.createHash("sha256").update(source).digest("hex");
  const script =
    fs.readFileSync(
      new URL("../server/update_worker.py", import.meta.url),
      "utf8",
    ) +
    "\nimport base64\nprint(json.dumps(apply(" +
    (server.mode === "wsl"
      ? "pathlib.Path('/opt/starport/worker')"
      : "pathlib.Path.home()/'.local/share/starport-pi-server'") +
    ",base64.b64decode('" +
    source.toString("base64") +
    "'),'" +
    hash +
    "')))\n";
  const output =
    server.mode === "wsl"
      ? await execute(
          "wsl.exe",
          wslArgs(server.distribution, "/usr/local/bin/python3", "-I", "-"),
          script,
        )
      : await execute(
          "ssh",
          [...sshArgs(name, server, root), "python3 -I -"],
          script,
        );
  const result = JSON.parse(output.toString());
  if (result.sha256 !== hash || result.updated !== true)
    throw new Error("worker_update_unverified");
  const remote = new Remote(config, root, { call: execute });
  const health = await remote.call("health");
  if (!health.capabilities?.fileManagement)
    throw new Error("worker_update_unverified");
  return {
    updated: true,
    restartRequired: false,
    name,
    capabilities: health.capabilities,
  };
}
