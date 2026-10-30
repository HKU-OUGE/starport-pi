#!/usr/bin/env node
// This helper is invoked only by the operator's explicit system authorization.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { findKeys } from "../src/keys.mjs";
const request = path.resolve(process.argv[2]),
  folder = path.dirname(request),
  owner = fs.statSync(folder);
if (
  fs.lstatSync(request).isSymbolicLink() ||
  fs.lstatSync(folder).isSymbolicLink()
)
  throw new Error("invalid_request");
const input = JSON.parse(fs.readFileSync(request, "utf8"));
const match = (await findKeys(input)).find((k) => k.file);
if (match) {
  const output = path.join(folder, "matched-key");
  const data = fs.readFileSync(match.file);
  fs.writeFileSync(output, data, { flag: "wx", mode: 0o600 });
  if (process.platform !== "win32") fs.chownSync(output, owner.uid, owner.gid);
  const result = path.join(folder, "result.json");
  fs.writeFileSync(
    result,
    JSON.stringify({
      found: true,
      sha256: crypto.createHash("sha256").update(data).digest("hex"),
    }),
    { flag: "wx", mode: 0o600 },
  );
  if (process.platform !== "win32") fs.chownSync(result, owner.uid, owner.gid);
} else {
  const result = path.join(folder, "result.json");
  fs.writeFileSync(result, JSON.stringify({ found: false }), {
    flag: "wx",
    mode: 0o600,
  });
  if (process.platform !== "win32") fs.chownSync(result, owner.uid, owner.gid);
}
