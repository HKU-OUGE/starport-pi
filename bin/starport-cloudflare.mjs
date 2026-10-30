#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { stateRoot } from "../src/config.mjs";
import { Cloudflare, Enrollment, readEnrollment } from "../src/cloudflare.mjs";

async function main() {
  const [action, file] = process.argv.slice(2),
    root = stateRoot();
  if (!["plan", "apply", "status", "rollback", "start"].includes(action)) {
    console.log(
      "node bin/starport-cloudflare.mjs plan|apply|status|rollback private-enrollment.json\nnode bin/starport-cloudflare.mjs start",
    );
    return;
  }
  if (action === "start") {
    const receipt = JSON.parse(
      fs.readFileSync(path.join(root, "cloudflare", "receipt.json"), "utf8"),
    );
    if (receipt.stage !== "configured")
      throw new Error("cloudflare_apply_required");
    const child = spawn(
      "cloudflared",
      [
        "tunnel",
        "--no-autoupdate",
        "run",
        "--token-file",
        path.join(root, "cloudflare", "tunnel-token"),
      ],
      { stdio: "inherit", windowsHide: true, shell: false },
    );
    child.once("error", () => {
      console.error("Install cloudflared 2025.4.0 or later.");
      process.exitCode = 1;
    });
    for (const signal of ["SIGINT", "SIGTERM"])
      process.once(signal, () => child.kill());
    child.on("exit", (code) => {
      process.exitCode = code || 0;
    });
    return;
  }
  if (!file) throw new Error("enrollment_file_required");
  const { config, token } = readEnrollment(file),
    enrollment = new Enrollment(new Cloudflare(token), root);
  const result =
    action === "plan"
      ? await enrollment.plan(config)
      : await enrollment[action]();
  console.log(
    JSON.stringify(
      {
        stage: result.stage,
        url: "https://" + result.hostname,
        port: result.port,
        allowedEmails: result.allowedEmails,
        pending: result.pending?.key || null,
      },
      null,
      2,
    ),
  );
}
main().catch((e) => {
  console.error(
    /^[a-z0-9_]{1,100}$/.test(e.message)
      ? e.message
      : "cloudflare_configuration_failed",
  );
  process.exitCode = 1;
});
