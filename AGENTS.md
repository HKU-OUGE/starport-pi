# Starport Pi — Agent entrypoint

For installation, server configuration, or remote access enrollment, read
[skills/starport-setup/SKILL.md](skills/starport-setup/SKILL.md).
For an explicitly requested removal, read
[skills/starport-uninstall/SKILL.md](skills/starport-uninstall/SKILL.md).

This is a Windows-native Pi SDK workbench. The operator process manages
credentials and connections; model-generated commands run on a remote Linux
worker. WSL2 is optional. Use the repository's actual commands and validation
receipts; do not substitute the upstream Pi local shell for the remote tools.

For source changes, keep user identities, real deployment addresses, credentials
and runtime state out of Git. Examples use `example.com` / `example.invalid`.
Preserve existing installations and running jobs. Run the relevant Node/Python
tests and `python scripts/audit_source.py` before publishing changes.

A deployment request can authorize configuration changes; this file does not
itself authorize creating cloud resources, changing another user's policy, or
restarting unrelated services. Once scope is authorized, carry it through
without repeated permission questions.
