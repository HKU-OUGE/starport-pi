import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { gunzipSync } from "node:zlib";
import { Agent, ProxyAgent, fetch } from "undici";
import { privateDir, writePrivate } from "./config.mjs";
import { processCall } from "./transport.mjs";
const assets = JSON.parse(
  fs.readFileSync(new URL("./tool-assets.json", import.meta.url), "utf8"),
);
export async function verifiedDownload(
  root,
  name,
  url,
  sha256,
  { proxyPort, onProgress = () => {} } = {},
) {
  const dir = privateDir(path.join(root, "install-cache")),
    dest = path.join(dir, name);
  const hashFile = async (file) => {
    const h = crypto.createHash("sha256");
    for await (const b of fs.createReadStream(file)) h.update(b);
    return h.digest("hex");
  };
  if (fs.existsSync(dest)) {
    if ((await hashFile(dest)) === sha256) return dest;
    throw new Error("download_cache_checksum_failed");
  }
  const dispatcher = proxyPort
    ? new ProxyAgent("http://127.0.0.1:" + proxyPort)
    : new Agent();
  let fd;
  try {
    let current = url,
      r;
    for (let n = 0; n < 6; n++) {
      const u = new URL(current);
      if (
        u.protocol !== "https:" ||
        u.username ||
        u.password ||
        ![
          "github.com",
          "release-assets.githubusercontent.com",
          "objects.githubusercontent.com",
          "help-static-aliyun-doc.aliyuncs.com",
        ].includes(u.hostname)
      )
        throw new Error("download_host_not_allowed");
      r = await fetch(u, {
        dispatcher,
        redirect: "manual",
        signal: AbortSignal.timeout(300000),
      });
      if ([301, 302, 303, 307, 308].includes(r.status)) {
        current = new URL(r.headers.get("location"), u).href;
        await r.body.cancel();
        continue;
      }
      break;
    }
    if (!r.ok) throw new Error("tool_download_failed");
    fd = fs.openSync(dest + ".partial", "w", 0o600);
    const hash = crypto.createHash("sha256");
    let total = 0,
      last = 0;
    for await (const b of r.body) {
      total += b.length;
      if (total > 512 * 1024 * 1024) throw new Error("download_too_large");
      hash.update(b);
      fs.writeSync(fd, b);
      if (Date.now() - last > 250) {
        onProgress(total, Number(r.headers.get("content-length")) || 0);
        last = Date.now();
      }
    }
    fs.closeSync(fd);
    fd = undefined;
    if (hash.digest("hex") !== sha256)
      throw new Error("download_checksum_failed");
    fs.renameSync(dest + ".partial", dest);
    return dest;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    await dispatcher.close();
  }
}
export async function installTool(root, name, options = {}) {
  const asset = assets[name]?.[process.platform + "-" + process.arch];
  if (!asset) throw new Error("unsupported_tool_platform");
  const dir = privateDir(path.join(root, "tools")),
    dest = path.join(dir, name + (process.platform === "win32" ? ".exe" : ""));
  if (fs.existsSync(dest) && fs.existsSync(dest + ".receipt.json")) {
    const saved = JSON.parse(fs.readFileSync(dest + ".receipt.json", "utf8"));
    if (
      saved.sourceSha256 === asset.sha256 &&
      crypto
        .createHash("sha256")
        .update(fs.readFileSync(dest))
        .digest("hex") === saved.sha256
    )
      return dest;
    throw new Error("installed_tool_checksum_failed");
  }
  const archive = await verifiedDownload(
    root,
    name + "-" + asset.sha256.slice(0, 12),
    asset.url,
    asset.sha256,
    options,
  );
  if (asset.format === "binary") fs.copyFileSync(archive, dest);
  else if (asset.format === "gz")
    fs.writeFileSync(
      dest,
      gunzipSync(fs.readFileSync(archive), {
        maxOutputLength: 256 * 1024 * 1024,
      }),
    );
  else {
    const python =
      process.env.STARPORT_PYTHON ||
      (process.platform === "win32" ? "python" : "python3");
    const script = `import sys,json,pathlib,zipfile,tarfile\na=json.load(sys.stdin)\np=pathlib.Path(a['archive'])\nif a['format']=='zip':\n z=zipfile.ZipFile(p);m=[i for i in z.infolist() if not i.is_dir() and i.filename.endswith('.exe')];assert len(m)==1 and m[0].file_size<268435456;b=z.read(m[0])\nelse:\n z=tarfile.open(p);m=[i for i in z.getmembers() if i.isfile() and pathlib.PurePosixPath(i.name).name==a['name']];assert len(m)==1 and m[0].size<268435456;b=z.extractfile(m[0]).read()\npathlib.Path(a['dest']).write_bytes(b)\n`;
    // Python executes this fixed extraction program; browser input cannot supply code.
    await processCall(
      python,
      ["-I", "-c", script],
      JSON.stringify({ archive, dest, format: asset.format, name }),
      { timeout: 30000 },
    );
  }
  fs.chmodSync(dest, 0o700);
  writePrivate(dest + ".receipt.json", {
    sourceSha256: asset.sha256,
    sha256: crypto
      .createHash("sha256")
      .update(fs.readFileSync(dest))
      .digest("hex"),
  });
  return dest;
}
export const rootfsRelease = {
  url: "https://github.com/HKU-OUGE/starport-pi/releases/download/v0.1.0/rootfs.tar.gz",
  sha256: "7eb28adda385026c7bdb072f067357cf44baff608162248d772a70e74a367c8e",
};
