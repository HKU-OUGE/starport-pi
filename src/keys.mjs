import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { processCall } from "./transport.mjs";
import { privateDir } from "./config.mjs";
export function publicKey(value) {
  const m = String(value)
    .trim()
    .match(
      /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp\d+) ([A-Za-z0-9+/=]+)(?:\s.*)?$/,
    );
  if (!m) throw new Error("invalid_public_key");
  return m[1] + " " + m[2];
}
export function fingerprint(value) {
  return (
    "SHA256:" +
    crypto
      .createHash("sha256")
      .update(Buffer.from(publicKey(value).split(" ")[1], "base64"))
      .digest("base64")
      .replace(/=+$/, "")
  );
}
export async function findKeys({
  directory = path.join(os.homedir(), ".ssh"),
  publicKey: expected,
} = {}) {
  const match = expected ? publicKey(expected) : null;
  const results = [];
  const dir = path.resolve(directory);
  const names = fs.readdirSync(dir).slice(0, 200);
  for (const name of names) {
    const file = path.join(dir, name);
    let st;
    try {
      st = fs.lstatSync(file);
    } catch {
      continue;
    }
    if (
      st.isSymbolicLink() ||
      !st.isFile() ||
      st.size > 65536 ||
      /\.(pub|json|log)$/.test(name) ||
      ["config", "known_hosts", "authorized_keys"].includes(name)
    )
      continue;
    const head = fs.readFileSync(file, "utf8");
    if (!head.includes("PRIVATE KEY-----")) continue;
    try {
      const out = (
        await processCall("ssh-keygen", ["-y", "-P", "", "-f", file], "", {
          timeout: 3000,
        })
      )
        .toString()
        .trim();
      if (!match || publicKey(out) === match)
        results.push({
          name,
          file,
          fingerprint: fingerprint(out),
          publicKey: publicKey(out),
          sha256: crypto.createHash("sha256").update(head).digest("hex"),
        });
    } catch {
      // A .pub sidecar alone is not proof that an encrypted private key matches.
      results.push({ name, locked: true, matched: false });
    }
  }
  return results;
}
export async function elevatedMatch(root, directory, expected) {
  const requestDir = privateDir(
      path.join(root, "key-requests", crypto.randomBytes(12).toString("hex")),
    ),
    requestFile = path.join(requestDir, "request.json");
  fs.writeFileSync(
    requestFile,
    JSON.stringify({
      directory: path.resolve(directory),
      publicKey: publicKey(expected),
    }),
    { mode: 0o600 },
  );
  const script = fileURLToPath(
    new URL("../scripts/key-helper.mjs", import.meta.url),
  );
  let command, args;
  if (process.platform === "win32") {
    command = "powershell.exe";
    args = [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      fileURLToPath(new URL("../scripts/key-elevate.ps1", import.meta.url)),
      "-Node",
      process.execPath,
      "-Helper",
      script,
      "-Request",
      requestFile,
    ];
  } else if (process.platform === "darwin") {
    command = "osascript";
    const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
    args = [
      "-e",
      "on run argv\ndo shell script (item 1 of argv) with administrator privileges\nend run",
      [process.execPath, script, requestFile].map(quote).join(" "),
    ];
  } else {
    command = "pkexec";
    args = [process.execPath, script, requestFile];
  }
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "ignore",
      windowsHide: false,
      shell: false,
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("administrator_prompt_timeout"));
    }, 120000);
    child.on("error", () => {
      clearTimeout(timer);
      reject(new Error("administrator_prompt_unavailable"));
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve()
        : reject(new Error("administrator_action_cancelled"));
    });
  });
  const result = JSON.parse(
    fs.readFileSync(path.join(requestDir, "result.json"), "utf8"),
  );
  if (!result.found) throw new Error("matching_private_key_not_found");
  return {
    file: path.join(requestDir, "matched-key"),
    name: "Imported key",
    publicKey: publicKey(expected),
    fingerprint: fingerprint(expected),
    sha256: result.sha256,
  };
}
