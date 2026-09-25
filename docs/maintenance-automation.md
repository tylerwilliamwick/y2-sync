# Scheduled Y2 Sync maintenance

Y2 Sync includes an opt-in macOS LaunchAgent that audits the tracked upstream tip every six hours. A best-effort watch on the exact local `HEAD` reflog also triggers after local commits; the interval remains authoritative because launchd path watches can coalesce or miss events.

## Safety contract

- The operator worktree is never edited. Each run requires an explicit `origin/*` upstream and uses separate disposable, no-hardlink clones pinned to that commit SHA for initial gates, review/remediation, and final validation. Gate side effects are discarded before review or repair.
- Installation atomically snapshots the reviewed runner and its JSON schema into the private maintenance state directory. Scheduled and manual runs execute that installed copy, so checking out another branch cannot replace the pre-sandbox launcher.
- Fixed deterministic gates run before any model review: formatting, Node/Python regressions, UI build, locally generated audio fixtures, locked Rust dependency prefetch, canonical FFmpeg source download plus offline checksum verification, offline daemon check/tests, support-crate tests, and production-dependency audit.
- Every model tool and quality gate runs under a macOS Seatbelt profile. The user home is denied except for explicit toolchain paths, and broad temporary roots are read-only except for disposable clones, isolated scratch space, and bounded caches. External network access is enabled only for dependency acquisition and audit. Repository Rust code compiles and tests with Cargo's offline mode enforced; only Cargo's two advisory lock files remain writable in the otherwise read-only dependency cache. Native tests may bind loopback mock servers through Codex's default-deny managed network; a preceding probe requires loopback success and an HTTP 403 for external egress.
- Codex first reviews with read-only workspace access. Remediation uses workspace-write access with approvals disabled, no Git/GitHub credential configuration, and a sanitized environment that excludes tokens, secrets, and agent sockets.
- Existing Git credentials are exposed only to the trusted origin fetch, validated branch push, and GitHub CLI pull-request creation. They are never exposed to repository gates or model processes.
- The resulting patch is bounded and inspected for path traversal, binaries, common credential/private-key formats, symlinks, submodules, mode changes, deletions, and oversized files. Existing standalone tests and Rust files containing inline tests are immutable; remediation may only add a new regression test.
- The exact accepted patch is reapplied to a second clean clone. An independent second gate run must pass, and its staged bytes must still match the accepted patch exactly. Workflows, manifests, lockfiles, capabilities, release code, and the automation itself cannot be changed automatically.
- Successful fixes are committed to a timestamped `automation/maintenance-*` branch and opened as a **draft** pull request. Drafts do not execute repository code in CI; a maintainer must mark the pull request ready first. The automation never merges, force-pushes, publishes, signs, or modifies repository settings.
- Bounded JSON reports and redacted logs are stored with mode `0600` under `~/Library/Application Support/Y2 Sync Maintenance`. Recoverable dependency caches and disposable clones live only in separate mode-`0700` directories beneath the macOS per-user temporary directory, so build tools never need access to the denied home directory. Only the latest 30 reports are retained.
- Dirty local edits are detected and recorded but never copied, reviewed, or changed.
- A kernel-backed macOS `lockf` lock covers each whole run. The kernel releases it on exit or crash, and overlapping manual or scheduled invocations exit cleanly. Each bounded command owns a separate process group so a timeout terminates descendants before the run proceeds. Disposable clones use a state-scoped temporary namespace; after an unclean exit, the next lock holder removes every abandoned clone in that namespace and finalizes reports left `running` before starting new work.

## Commands

Installation requires a full-history (non-shallow) Git clone so every reviewed range is complete. Re-run `maintenance:install` after updating the automation to install the newly reviewed runner snapshot.

```bash
rtk npm run maintenance:install
rtk npm run maintenance:status
rtk npm run maintenance:run
```

For a deterministic audit without automated remediation:

```bash
rtk npm run maintenance:audit -- --skip-review
```

Uninstalling is intentionally explicit and retains prior reports:

```bash
rtk proxy node scripts/install-y2-maintenance.mjs uninstall
```

The LaunchAgent label is `com.tylerwick.y2-sync-maintenance`. It runs in the signed-in user session and relies on that user’s existing GitHub CLI and Codex authentication. A `--skip-review` run verifies gates but does not mark the commit reviewed. A failure never falls back to an unsafe shell or unsandboxed execution; it is recorded for the next scheduled retry.
