---
name: starport-uninstall
description: Disable or uninstall an authorized Starport Pi profile, remove its current-user sign-in startup, and stop only verified local components while preserving credentials, sessions and remote data by default. Use when the user asks to remove or stop a deployment; never run it merely because installation failed.
---

# Starport Pi removal

This is an operator-side skill. Do not expose it as a model tool inside Pi.

## Confirm scope from the user's request

Resolve the repository and the intended `STARPORT_PI_STATE` profile. Inspect
running jobs, local processes, sign-in registrations and the private Cloudflare
receipt. Do not print credentials or full process command lines in chat.

Distinguish disabling local services from deleting private state, Cloudflare
resources or remote workers. Preserve the latter by default. Ask only about scope
that is still unclear; honor authorization already provided in the conversation.
If active jobs depend on this computer's proxy, explain that stopping it blocks
their networking. Do not cancel jobs or delete remote files as part of a local
uninstall unless separately authorized.

## Windows: inspect, then stop this profile

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1 -Apply
```

The first command is a read-only plan. The second removes the matching
current-user sign-in task and stops only processes attributed to this profile.
It rechecks creation time and command line before stopping a process. A panel
whose identity cannot be verified must be closed from its own console instead;
do not broaden the process filter or run `taskkill /IM node.exe`.

The script keeps the repository and all private state. Verify that the named task
is absent and the identified processes stopped. Older SSH tunnels without a
profile-specific known-host path require a separate ownership check; do not
claim all network paths were removed when they were not identified.

To remove only automatic sign-in startup, use:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\register-panel.ps1 -Remove
```

This removes the scheduled registration. Check any already running instance
separately; removing a schedule alone is not proof its current process stopped.

## Linux and macOS

Inspect the actual user systemd unit, launchd job, or terminal used for this
profile. The repository does not automatically create those registrations.
Stop only verified owned components, using their original service manager where
possible. Do not guess a unit name or stop all Node, SSH, or proxy processes.

## Optional cleanup requires the corresponding authorization

- Cloudflare: use the existing private enrollment and
  `node bin/starport-cloudflare.mjs rollback path/to/private-enrollment.json`.
  The receipt limits deletion to owned resources. Check uncertain creation
  outcomes with `status`; do not overwrite another application or wildcard policy.
- Private state or repository: inventory the exact paths, explain what would be
  lost, and obtain explicit deletion approval if not already provided. Preserve
  data the user wants to keep. No recursive deletion is part of the default script.
- Remote worker: inspect running jobs, datasets and environment reuse first.
  Local uninstall is not authorization to remove it, restart DSW, or reclaim GPUs
  used by another service.
- Shared prerequisites: keep Node.js, Python, OpenSSH and WSL unless their removal
  is explicitly requested and other applications do not depend on them.

Report what was disabled, what remains, and the evidence. Do not report complete
removal when only a startup registration was deleted.

## Owned local runtime

The default uninstall preserves the dedicated WSL2 disk and its projects. Do not
run `wsl --shutdown` or unregister other distributions. Terminating the owned
distribution would stop its jobs; obtain explicit scope before doing so. Before
any requested permanent removal, verify the distribution and owner marker against
the private receipt and export wanted projects. Removing startup registration
alone does not delete a local runtime.
