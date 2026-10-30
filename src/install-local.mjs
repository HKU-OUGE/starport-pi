import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { load, save, privateDir, writePrivate } from "./config.mjs";
import { processCall, Remote } from "./transport.mjs";
import { wslArgs } from "./local-bridge.mjs";
import { verifiedDownload, rootfsRelease } from "./install-tools.mjs";
import { downloadRuntime } from "./install-remote.mjs";

const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export function decodeWslList(buffer) {
  const b = Buffer.from(buffer);
  return b
    .toString(b.includes(0) ? "utf16le" : "utf8")
    .replaceAll("\u0000", "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}
export async function installLocal(
  root,
  { cpus = 4, memoryGiB = 4, stage = () => {}, verify } = {},
) {
  if (process.platform !== "win32" || process.arch !== "x64")
    throw new Error("local_runtime_requires_windows_x64");
  if (
    !Number.isInteger(cpus) ||
    cpus < 1 ||
    cpus > 64 ||
    !Number.isInteger(memoryGiB) ||
    memoryGiB < 2 ||
    memoryGiB > 256
  )
    throw new Error("invalid_local_budget");
  const c = load(root);
  if (c.servers.local && c.servers.local.mode !== "wsl")
    throw new Error("local_server_name_in_use");
  if (!c.proxy.selected) throw new Error("select_proxy_before_local_setup");
  if (typeof verify !== "function") throw new Error("local_verifier_required");
  stage("checking_wsl2");
  let names;
  try {
    await processCall("wsl.exe", ["--status"], "");
    names = decodeWslList(
      await processCall("wsl.exe", ["--list", "--quiet"], ""),
    );
  } catch {
    throw new Error("wsl2_setup_required");
  }
  const dir = privateDir(path.join(root, "local-runtime")),
    receiptFile = path.join(dir, "receipt.json");
  let r = fs.existsSync(receiptFile)
    ? JSON.parse(fs.readFileSync(receiptFile, "utf8"))
    : null;
  if (r && (r.cpus !== cpus || r.memoryGiB !== memoryGiB))
    throw new Error("existing_local_budget_differs");
  if (!r) {
    r = {
      distribution: "StarportRuntime-" + crypto.randomBytes(8).toString("hex"),
      owner: crypto.randomBytes(24).toString("hex"),
      cpus,
      memoryGiB,
      phase: "prepared",
    };
    writePrivate(receiptFile, r);
  }
  const ownedArgs = (...args) => wslArgs(r.distribution, ...args);
  const python = "/usr/local/bin/python3";
  if (names.includes(r.distribution)) {
    let owner;
    try {
      owner = (
        await processCall(
          "wsl.exe",
          ownedArgs(
            python,
            "-I",
            "-c",
            "import pathlib;print(pathlib.Path('/opt/starport-bootstrap/owner').read_text())",
          ),
          "",
        )
      )
        .toString()
        .trim();
    } catch {
      throw new Error("local_import_incomplete_inspect_before_resuming");
    }
    if (owner !== r.owner) throw new Error("local_runtime_ownership_mismatch");
  } else {
    if (r.phase !== "prepared" && r.phase !== "importing")
      throw new Error("registered_local_runtime_missing");
    stage("downloading_rootfs");
    const archive = await verifiedDownload(
      root,
      "rootfs-v0.1.0.tar.gz",
      rootfsRelease.url,
      rootfsRelease.sha256,
      {
        proxyPort: c.proxy.port,
        onProgress: (bytes, total, detail) =>
          stage("downloading_rootfs", { bytes, total, ...detail }),
      },
    );
    stage("downloading_runtime");
    const runtime = await downloadRuntime(c, root, "x86_64", {
      onProgress: (bytes, total, detail) =>
        stage("downloading_runtime", { bytes, total, ...detail }),
    });
    const bootstrap = path.join(dir, "bootstrap.tar");
    // Only rebuild our own unregistered import archive; never touch a VHD or distro.
    if (fs.existsSync(bootstrap)) fs.rmSync(bootstrap);
    stage("preparing_local_image");
    await processCall(
      process.env.STARPORT_PYTHON || "python",
      [
        "-I",
        path.join(repository, "scripts", "prepare-local-rootfs.py"),
        "--rootfs",
        archive,
        "--runtime",
        runtime,
        "--source",
        path.join(repository, "server"),
        "--output",
        bootstrap,
        "--cpus",
        String(cpus),
        "--memory",
        String(memoryGiB),
        "--owner",
        r.owner,
      ],
      "",
      { timeout: 600000 },
    );
    r.phase = "importing";
    writePrivate(receiptFile, r);
    stage("importing_owned_wsl2");
    await processCall(
      "wsl.exe",
      [
        "--import",
        r.distribution,
        path.join(dir, "disk"),
        bootstrap,
        "--version",
        "2",
      ],
      "",
      { timeout: 600000 },
    );
    r.phase = "imported";
    writePrivate(receiptFile, r);
    fs.rmSync(bootstrap, { force: true });
  }
  stage("checking_local_boundary");
  const check = `import os,pathlib,json
text=pathlib.Path('/etc/wsl.conf').read_text()
assert '[automount]\\nenabled=false' in text and '[interop]\\nenabled=false\\nappendWindowsPath=false' in text
assert not pathlib.Path('/mnt/c/Windows').exists()
assert not os.path.exists('/proc/sys/fs/binfmt_misc/WSLInterop')
assert 'microsoft' in pathlib.Path('/proc/sys/kernel/osrelease').read_text().lower()
assert len(os.sched_getaffinity(0))>=${cpus}
memory=int(next(x for x in pathlib.Path('/proc/meminfo').read_text().splitlines() if x.startswith('MemTotal:')).split()[1])
assert memory>=${memoryGiB}*1024*1024
print(json.dumps({'worker':pathlib.Path('/opt/starport/worker/config.json').exists()}))`;
  let state;
  try {
    state = JSON.parse(
      await processCall("wsl.exe", ownedArgs(python, "-I", "-"), check),
    );
  } catch {
    throw new Error("local_boundary_or_resource_check_failed");
  }
  if (!state.worker) {
    stage("installing_local_worker");
    r.phase = "installing";
    writePrivate(receiptFile, r);
    await processCall(
      "wsl.exe",
      ownedArgs(python, "-I", "/opt/starport-bootstrap/initialize.py"),
      "",
      { timeout: 600000 },
    );
  }
  r.phase = "verifying";
  writePrivate(receiptFile, r);
  const next = load(root);
  next.servers.local = {
    mode: "wsl",
    distribution: r.distribution,
    initialized: false,
    budget: { cpus, memoryGiB, gpus: [] },
  };
  save(next, root);
  const selected = { ...next, activeServer: "local" },
    remote = new Remote(selected, root);
  stage("connecting_local_proxy");
  await remote.tunnel(c.proxy.port);
  stage("verifying_isolation");
  selected.workspace = (await remote.call("workspace.create")).id;
  const proof = await verify(remote);
  const latest = load(root);
  latest.servers.local.initialized = true;
  save(latest, root);
  r.phase = "ready";
  r.probe = proof;
  writePrivate(receiptFile, r);
  return {
    name: "local",
    ready: true,
    isolationVerified: true,
    cpus,
    memoryGiB,
    gpus: 0,
  };
}
