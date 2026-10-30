import test from "node:test";
import assert from "node:assert/strict";
import { updateWorker } from "../src/update-worker.mjs";

test("operator worker updates use fixed SSH and WSL entrypoints then verify capabilities", async () => {
  for (const mode of ["ssh", "wsl"]) {
    const server =
      mode === "ssh"
        ? { mode, host: "worker.example.invalid", initialized: true }
        : {
            mode,
            distribution: "StarportRuntime-" + "a".repeat(16),
            initialized: true,
          };
    const calls = [];
    const execute = async (program, args, input) => {
      calls.push({ program, args });
      if (input.startsWith('"""Atomic')) {
        assert.ok(!input.includes("kill("));
        assert.ok(
          input.includes(
            mode === "ssh" ? "pathlib.Path.home()" : "/opt/starport/worker",
          ),
        );
        const hash = input.match(/,'([a-f0-9]{64})'\)\)\)/)?.[1];
        assert.ok(hash);
        return Buffer.from(JSON.stringify({ updated: true, sha256: hash }));
      }
      assert.equal(JSON.parse(input).operation, "health");
      return Buffer.from(
        JSON.stringify({
          ok: true,
          result: { capabilities: { fileManagement: 1 } },
        }),
      );
    };
    const result = await updateWorker(
      { activeServer: "alpha", servers: { alpha: server } },
      ".",
      { execute },
    );
    assert.equal(result.updated, true);
    assert.equal(result.restartRequired, false);
    assert.equal(calls.length, 2);
    assert.ok(
      calls.every((c) => c.program === (mode === "ssh" ? "ssh" : "wsl.exe")),
    );
  }
  await assert.rejects(
    () =>
      updateWorker(
        { activeServer: "alpha", servers: { alpha: { initialized: false } } },
        ".",
      ),
    /verified_server_required/,
  );
});
