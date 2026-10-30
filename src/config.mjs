import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export function stateRoot() {
  return path.resolve(
    process.env.STARPORT_PI_STATE ||
      (process.platform === "win32"
        ? path.join(process.env.LOCALAPPDATA || os.homedir(), "StarportPi")
        : path.join(
            process.env.XDG_STATE_HOME ||
              path.join(os.homedir(), ".local", "state"),
            "starport-pi",
          )),
  );
}
export function privateDir(root) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(root).isSymbolicLink())
    throw new Error("private_directory_is_link");
  if (process.platform === "win32") {
    const user = process.env.USERDOMAIN
      ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
      : process.env.USERNAME;
    if (!user) throw new Error("windows_user_missing");
    const result = spawnSync(
      "icacls.exe",
      [root, "/inheritance:r", "/grant:r", `${user}:(OI)(CI)F`],
      { windowsHide: true, stdio: "pipe" },
    );
    if (result.status !== 0) throw new Error("private_directory_acl_failed");
  } else fs.chmodSync(root, 0o700);
  return root;
}
export function writePrivate(file, value) {
  privateDir(path.dirname(file));
  const next = file + ".next";
  if (fs.existsSync(next) && fs.lstatSync(next).isSymbolicLink())
    throw new Error("private_file_is_link");
  fs.writeFileSync(next, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
  });
  if (process.platform !== "win32") fs.chmodSync(next, 0o600);
  fs.renameSync(next, file);
}
export function load(root = stateRoot()) {
  privateDir(root);
  const file = path.join(root, "config.json");
  const config = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, "utf8"))
    : {
        format: 1,
        model: "claude-sonnet-5-5",
        effort: "high",
        activeServer: null,
        workspace: null,
        proxy: { mode: "required", port: 18889 },
        servers: {},
        subscriptions: [],
      };
  if (config.format !== 1 || config.proxy?.mode !== "required")
    throw new Error("invalid_configuration");
  return config;
}
export function save(config, root = stateRoot()) {
  writePrivate(path.join(root, "config.json"), config);
}
export function id(value) {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,39}$/.test(value))
    throw new Error("invalid_name");
  return value;
}
export function publicConfig(config) {
  return {
    model: config.model,
    effort: config.effort,
    activeServer: config.activeServer,
    workspace: config.workspace,
    region: "taiwan-utf8-v1",
    proxy: { required: true, selected: config.proxy.selected || null },
    servers: Object.keys(config.servers),
    subscriptions: config.subscriptions.map((s) => ({
      id: s.id,
      label: s.label,
    })),
  };
}

export function validateServer(server) {
  if (!server || !["ssh", "dsw", "wsl"].includes(server.mode))
    throw new Error("invalid_server_mode");
  if (server.mode === "wsl") {
    if (!/^StarportRuntime-[a-f0-9]{16}$/.test(server.distribution || ""))
      throw new Error("invalid_local_runtime");
    return server;
  }
  const text = (value) =>
    typeof value === "string" && value.length < 2048 && !/[\r\n\0]/.test(value);
  if (server.mode === "ssh") {
    if (
      !text(server.host) ||
      !/^[a-zA-Z0-9_.@-]+$/.test(server.host) ||
      server.host.startsWith("-")
    )
      throw new Error("invalid_ssh_host");
    if (
      server.port !== undefined &&
      (!Number.isInteger(server.port) || server.port < 1 || server.port > 65535)
    )
      throw new Error("invalid_ssh_port");
    if (server.identityFile !== undefined && !text(server.identityFile))
      throw new Error("invalid_ssh_key_path");
  } else {
    if (
      !/^dsw-[a-zA-Z0-9-]{4,100}$/.test(server.instanceId || "") ||
      !/^[a-z][a-z0-9-]{1,40}$/.test(server.region || "")
    )
      throw new Error("invalid_dsw_identity");
    if (
      ![server.proxyClient, server.credentialsFile, server.identityFile].every(
        text,
      )
    )
      throw new Error("invalid_dsw_paths");
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(server.user || ""))
      throw new Error("invalid_ssh_user");
  }
  if (server.knownHostsFile !== undefined && !text(server.knownHostsFile))
    throw new Error("invalid_known_hosts_file");
  return server;
}
