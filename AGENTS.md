# Codex Local Service

This repository packages a local inference service built from pinned `mehdic/codex-proxy` sources. Keep upstream MIT attribution and document intentional source changes.

- Runtime credentials belong under `/etc/codex-proxy/`, not in this repository. Never commit OAuth credentials, local proxy keys, machine-specific backup records, or business data.
- Ordinary client integration reuses the installed service. It does not require another proxy deployment or edits to the user's global Codex provider.
- Preserve loopback binding, Bearer authentication, Origin rejection, and inference-only tool restrictions.
- Verify changed launch/configuration behavior and a real model request when modifying runtime integration. A health response alone does not establish working inference.
- `upstream/dist` and `upstream/node_modules` are generated/installed artifacts and remain untracked. Local migration notes in `docs/LOCAL.md` remain untracked.
