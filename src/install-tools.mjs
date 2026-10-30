import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { gunzipSync } from "node:zlib";
import { privateDir, writePrivate } from "./config.mjs";
import { processCall } from "./transport.mjs";
const assets = JSON.parse(
  fs.readFileSync(new URL("./tool-assets.json", import.meta.url), "utf8"),
);
export { verifiedDownload } from "./download.mjs";
import { verifiedDownload } from "./download.mjs";
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
