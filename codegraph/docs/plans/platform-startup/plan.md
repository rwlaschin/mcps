---
modified: 2026-10-08
dependencies: [../../design/mcp-and-cli.md, ../../design/visualizer.md]
supersedes: null
---

# Platform startup fixes

## Problem

The visualizer executable guard mishandles file URLs. Daemon startup discards child diagnostics and applies POSIX permission bits on Windows.

## Solution

Use Node's file URL conversion, retain bounded startup diagnostics without a detached stderr pipe, and apply POSIX permission checks only on POSIX. Preserve the existing fixed loopback transport.

## APPROVED REQUIREMENTS

1. Replace the visualizer main-module guard's URL pathname with `fileURLToPath(import.meta.url)`; preserve imported-module behavior and the existing command and routes.
2. Preserve the authenticated machine-wide loopback TCP endpoint, singleton binding, worker budget, request shapes and existing injected startup callbacks returning undefined. Do not introduce named pipes or another service.
3. Retain actual launcher stderr and exit/signal details in displayed readiness errors and causes. Redirect detached child stderr to an exclusively created temporary regular file, close the parent descriptor after spawn, read at most 8192 tail bytes on failure, and unlink on authenticated readiness or terminal failure. Keep the child's stderr descriptor valid, detach diagnostic listeners, do not await healthy-child exit or kill another owner's daemon, and reuse the existing readiness deadline.
4. Preserve token directory/file type and symlink checks on every platform; apply POSIX mode and UID checks only on POSIX. Windows uses the inherited ACL of the existing per-user temporary directory; do not claim ACL verification or introduce ACL tooling.
5. Keep source edits confined to `visualizer.mjs` and `query-daemon.mjs`. Preserve prior changes, dependencies, versions and stored formats. Independently verify executable paths with spaces, startup failures and cleanup, cross-platform branches and existing daemon behavior; report Windows execution as unverified unless run on Windows.

## Target Design Docs

Update the executable-guard and startup-diagnostic descriptions in `docs/design/visualizer.md` and `docs/design/mcp-and-cli.md` after verification. Do not rewrite unrelated stale subsystem descriptions.

## Testing Requirements

Use integration tests for executable startup, transport authentication and resource cleanup, plus unit tests for platform permission branches.

An independent test engineer writes `test/platform-startup.test.mjs` in existing Node test conventions before source edits; run `node --test test/platform-startup.test.mjs` and the existing daemon regressions in `test/query-daemon.test.mjs`. Exercise actual visualizer executable startup from a path containing spaces/encoded characters and imported-module behavior; verify the fixed transport across POSIX and Windows platform branches. Exercise child spawn failure, early exit with stderr and code or signal, delayed readiness, authenticated success, singleton loser success, existing undefined-returning startup injection, bounded diagnostic tails, parent descriptor/listener release and temporary-file removal. Preserve Unix insecure-token rejection and verify Windows mode handling retains symlink/type rejection. Host-only checks must not claim actual Windows execution.

## Parallel / Dependent Breakdown

1. Independent scope and contract inspection establish the two source files and startup receipt behavior.
2. Independent QA writes focused checks before source implementation.
3. One source worker implements requirements 1–5 without editing tests.
4. The orchestrator compares the actual delta to this checklist and reruns focused checks, then independently reviews the source and reports platform limitations.

## Success Criteria

- Visualizer executable starts from an encoded/space-containing path and imports without listening.
- Startup failures expose actual child details; successful detached service startup leaves no parent diagnostic descriptor or temporary pathname.
- POSIX credential protections remain enforced and Windows no longer fails because of unsupported POSIX mode distinctions.
- Fixed authenticated TCP remains shared across repositories and clients.
- Focused checks pass with zero skips, and platform/runtime limitations are explicitly reported.
