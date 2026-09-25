import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import {
  addedPatchContainsSecret,
  assertExactPatchPaths,
  assertExactValidatedPatch,
  baseBranchFromUpstream,
  defaultCacheDir,
  discoverNodeTests,
  finalizeInterruptedReports,
  isAllowedAutomatedFixPath,
  isRunnableAddedTestPath,
  maintenanceBranchName,
  maintenanceConfigurationFingerprint,
  maintenanceGatePlan,
  maintenanceRunCacheRoot,
  maintenanceWorkspacePlan,
  modelEnvironment,
  nativeLockArguments,
  parsePatchNumstat,
  parseGitHubOrigin,
  parseMaintenanceArgs,
  redactText,
  removeAbandonedReportTemps,
  resolveContainedDirectory,
  reviewRange,
  retainExactStdout,
  rustSourceContainsTests,
  sandboxPermissionOverride,
  scavengeAbandonedRunRoots,
  sanitizedEnvironment,
  shouldAttemptRemediation,
  validatedAudioRuntimeSource,
  validateAutomatedDiff,
} from "../y2-maintenance.mjs";
import {
  buildMaintenancePlist,
  maintenanceConfiguration,
  requireFullHistory,
  xmlEscape,
} from "../install-y2-maintenance.mjs";

const root = resolve(import.meta.dirname, "../..");
const sha = "a".repeat(40);

test("GitHub origin parsing accepts credential-free HTTPS and SSH URLs", () => {
  assert.deepEqual(parseGitHubOrigin("https://github.com/owner/repo.git"), {
    slug: "owner/repo",
    url: "https://github.com/owner/repo.git",
  });
  assert.deepEqual(parseGitHubOrigin("git@github.com:owner/repo.git"), {
    slug: "owner/repo",
    url: "git@github.com:owner/repo.git",
  });
  assert.deepEqual(parseGitHubOrigin("ssh://git@github.com/owner/repo.git"), {
    slug: "owner/repo",
    url: "ssh://git@github.com/owner/repo.git",
  });
  assert.throws(
    () => parseGitHubOrigin("https://token@github.com/owner/repo.git"),
    /without embedded credentials/,
  );
  assert.throws(
    () => parseGitHubOrigin("https://example.com/owner/repo.git"),
    /github\.com/,
  );
});

test("maintenance argument parsing is strict and resolves paths", () => {
  const parsed = parseMaintenanceArgs([
    "--repo",
    ".",
    "--force",
    "--audit-only",
    "--skip-review",
  ]);
  assert.equal(parsed.repoPath, resolve("."));
  assert.equal(parsed.force, true);
  assert.equal(parsed.auditOnly, true);
  assert.equal(parsed.skipReview, true);
  assert.throws(
    () => parseMaintenanceArgs(["--mystery"]),
    /unknown maintenance argument/,
  );
  assert.throws(() => parseMaintenanceArgs(["--config"]), /requires a path/);
});

test("maintenance targets only an explicit origin upstream", () => {
  assert.equal(
    baseBranchFromUpstream("origin/feat/local-library-y2", "local"),
    "feat/local-library-y2",
  );
  assert.throws(
    () => baseBranchFromUpstream("", "private-work"),
    /must track an origin branch/,
  );
  assert.throws(
    () => baseBranchFromUpstream("fork/private-work", "private-work"),
    /unsupported upstream/,
  );
});

test("a forced rerun reviews the target commit instead of an empty range", () => {
  assert.equal(reviewRange(sha, sha, false, true), `${sha}^..${sha}`);
});

test("rewritten history is reviewed against the previous audited tree", () => {
  const previous = "b".repeat(40);
  assert.equal(reviewRange(previous, sha, true), `${previous}..${sha}`);
  assert.equal(reviewRange(previous, sha, false), `${sha}^..${sha}`);
  assert.throws(
    () => reviewRange(null, sha, false, false),
    /parent is unavailable/,
  );
});

test("Node test discovery includes nested accepted regression tests", (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "y2-maintenance-tests-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const scriptTests = join(workspace, "scripts", "tests");
  const nestedTests = join(scriptTests, "nested");
  const uiTests = join(workspace, "hifimule-ui", "tests");
  mkdirSync(nestedTests, { recursive: true });
  mkdirSync(uiTests, { recursive: true });
  writeFileSync(join(scriptTests, "root.test.mjs"), "");
  writeFileSync(join(nestedTests, "regression.test.mjs"), "");
  writeFileSync(join(uiTests, "ui.test.mjs"), "");
  writeFileSync(join(nestedTests, "ignored.mjs"), "");
  assert.deepEqual(discoverNodeTests(workspace), [
    join("hifimule-ui", "tests", "ui.test.mjs"),
    join("scripts", "tests", "nested", "regression.test.mjs"),
    join("scripts", "tests", "root.test.mjs"),
  ]);
});

test("abandoned run cleanup is isolated by maintenance state directory", (t) => {
  const fixture = mkdtempSync(join(tmpdir(), "y2-maintenance-recovery-"));
  const firstRoot = maintenanceRunCacheRoot(join(fixture, "first-state"));
  const secondRoot = maintenanceRunCacheRoot(join(fixture, "second-state"));
  t.after(() => {
    rmSync(firstRoot, { recursive: true, force: true });
    rmSync(secondRoot, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  });
  assert.notEqual(firstRoot, secondRoot);
  const abandoned = join(firstRoot, "run-abandoned");
  const unrelated = join(firstRoot, "keep-me");
  mkdirSync(abandoned, { recursive: true });
  mkdirSync(unrelated, { recursive: true });
  assert.deepEqual(scavengeAbandonedRunRoots(firstRoot), [abandoned]);
  assert.equal(existsSync(abandoned), false);
  assert.equal(existsSync(unrelated), true);
});

test("startup recovery finalizes reports left running by abnormal exits", (t) => {
  const reportDir = mkdtempSync(join(tmpdir(), "y2-maintenance-reports-"));
  t.after(() => rmSync(reportDir, { recursive: true, force: true }));
  const runningPath = join(reportDir, "report-running.json");
  const passedPath = join(reportDir, "report-passed.json");
  writeFileSync(
    runningPath,
    JSON.stringify({ schemaVersion: 1, outcome: "running" }),
  );
  writeFileSync(
    passedPath,
    JSON.stringify({ schemaVersion: 1, outcome: "passed" }),
  );
  const completedAt = "2026-09-25T00:00:00.000Z";
  assert.deepEqual(finalizeInterruptedReports(reportDir, completedAt), [
    runningPath,
  ]);
  assert.deepEqual(JSON.parse(readFileSync(runningPath, "utf8")), {
    schemaVersion: 1,
    outcome: "interrupted",
    completedAt,
    error: "maintenance process ended before completion",
  });
  assert.equal(JSON.parse(readFileSync(passedPath, "utf8")).outcome, "passed");
});

test("startup recovery removes only validated atomic report remnants", (t) => {
  const reportDir = mkdtempSync(join(tmpdir(), "y2-maintenance-temps-"));
  t.after(() => rmSync(reportDir, { recursive: true, force: true }));
  const abandoned = join(reportDir, "report-run123.json.tmp-1234");
  const unrelated = join(reportDir, "report-run123.json.backup");
  writeFileSync(abandoned, "partial");
  writeFileSync(unrelated, "keep");
  assert.deepEqual(removeAbandonedReportTemps(reportDir), [abandoned]);
  assert.equal(existsSync(abandoned), false);
  assert.equal(existsSync(unrelated), true);
});

test(
  "contained maintenance directories reject symlink escapes",
  { skip: process.platform === "win32" },
  (t) => {
    const fixture = mkdtempSync(join(tmpdir(), "y2-maintenance-paths-"));
    t.after(() => rmSync(fixture, { recursive: true, force: true }));
    const root = join(fixture, "root");
    const outside = join(fixture, "outside");
    mkdirSync(root);
    mkdirSync(outside);
    const link = join(root, "linked");
    symlinkSync(outside, link, "dir");
    assert.equal(
      resolveContainedDirectory(join(root, "new"), root, "fixture"),
      join(root, "new"),
    );
    assert.throws(
      () => resolveContainedDirectory(link, root, "fixture"),
      /symbolic links|outside/,
    );
    assert.throws(
      () => resolveContainedDirectory(`${root}-sibling`, root, "fixture"),
      /outside its dedicated directory/,
    );
    if (process.platform === "darwin") {
      const aliasRoot = join(tmpdir(), "y2-maintenance-alias-root");
      const canonicalAliasTarget = join(
        realpathSync(tmpdir()),
        "y2-maintenance-alias-root",
        "new",
      );
      assert.equal(
        resolveContainedDirectory(canonicalAliasTarget, aliasRoot, "fixture"),
        canonicalAliasTarget,
      );
    }
  },
);

test("audio source prefetch accepts only the canonical checksum-pinned FFmpeg release", () => {
  const valid = {
    ffmpegRelease: "9.0.2",
    sourceUrl: "https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz",
    sourceSha256: "a".repeat(64),
  };
  const source = validatedAudioRuntimeSource(root, valid);
  assert.equal(source.sourceUrl, valid.sourceUrl);
  assert.ok(
    source.archivePath.endsWith(
      join("target", "audio-runtime", "sources", "ffmpeg-9.0.2.tar.xz"),
    ),
  );
  assert.throws(
    () =>
      validatedAudioRuntimeSource(root, {
        ...valid,
        sourceUrl: "https://example.com/ffmpeg.tar.xz",
      }),
    /canonical ffmpeg\.org/,
  );
  assert.throws(
    () =>
      validatedAudioRuntimeSource(root, { ...valid, sourceSha256: "short" }),
    /SHA-256/,
  );
});

test("sensitive environment values and common token shapes are removed from reports", () => {
  const clean = sanitizedEnvironment({
    PATH: "/usr/bin",
    GIT_EXTERNAL_DIFF: "/tmp/untrusted-diff",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "diff.bad.command",
    GIT_CONFIG_VALUE_0: "/tmp/untrusted-diff",
    GH_TOKEN: "ghp_supersecretvalue000000000000",
    OPENAI_API_KEY: "sk-supersecretvalue000000000000",
    SSH_AUTH_SOCK: "/tmp/agent.sock",
    DATABASE_URL: "postgres://user:password@example.invalid/database",
    NODE_OPTIONS: "--require=/tmp/untrusted.cjs",
    SAFE_SETTING: "yes",
  });
  assert.equal(clean.PATH, "/usr/bin");
  assert.equal(clean.SAFE_SETTING, undefined);
  assert.equal(clean.GH_TOKEN, undefined);
  assert.equal(clean.OPENAI_API_KEY, undefined);
  assert.equal(clean.SSH_AUTH_SOCK, undefined);
  assert.equal(clean.DATABASE_URL, undefined);
  assert.equal(clean.NODE_OPTIONS, undefined);
  assert.equal(clean.GIT_EXTERNAL_DIFF, undefined);
  assert.equal(clean.GIT_CONFIG_COUNT, undefined);
  assert.equal(clean.GIT_TERMINAL_PROMPT, "0");
  assert.equal(clean.GIT_CONFIG_GLOBAL, "/dev/null");
  assert.equal(clean.GIT_ATTR_NOSYSTEM, "1");
  assert.equal(clean.GIT_LITERAL_PATHSPECS, "1");
  assert.equal(clean.GIT_OPTIONAL_LOCKS, "0");
  const text = redactText(
    "Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz token=hidden https://alice:swordfish@github.com/owner/repo.git",
  );
  assert.doesNotMatch(
    text,
    /abcdefghijklmnopqrstuvwxyz|hidden|alice|swordfish/,
  );
  const authenticated = sanitizedEnvironment(
    {
      PATH: "/usr/bin",
      GH_TOKEN: "ghp_supersecretvalue000000000000",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      OPENAI_API_KEY: "sk-supersecretvalue000000000000",
    },
    { allowCredentials: true },
  );
  assert.equal(authenticated.GH_TOKEN, "ghp_supersecretvalue000000000000");
  assert.equal(authenticated.SSH_AUTH_SOCK, "/tmp/agent.sock");
  assert.equal(authenticated.OPENAI_API_KEY, undefined);
  assert.equal(authenticated.GIT_CONFIG_GLOBAL, undefined);
});

test("sandbox profiles deny the user home and grant only explicit maintenance roots", () => {
  assert.equal(defaultCacheDir, join(tmpdir(), "Y2SyncMaintenanceTooling"));
  const home = resolve(homedir());
  const fixtureRoot = join(tmpdir(), "y2-maintenance-profile-fixture");
  const workspace = join(fixtureRoot, "workspace");
  const scratchDir = join(fixtureRoot, "scratch");
  const localBin = join(fixtureRoot, ".local", "bin");
  const rtkPath = join(localBin, "rtk");
  const codexPath = join(localBin, "codex");
  const toolCacheDir = join(fixtureRoot, "cache");
  const profile = sandboxPermissionOverride({
    profileName: "test-profile",
    workspace,
    scratchDir,
    rtkPath,
    codexPath,
    toolCacheDir,
    network: false,
  });
  assert.ok(profile.includes(`${JSON.stringify(home)}="deny"`));
  assert.ok(
    profile.includes(`${JSON.stringify(realpathSync(home))}="deny"`),
  );
  assert.ok(profile.includes(`${JSON.stringify(resolve(tmpdir()))}="read"`));
  assert.ok(profile.includes(`${JSON.stringify(workspace)}="write"`));
  assert.ok(
    profile.includes(`${JSON.stringify(join(workspace, ".git"))}="read"`),
  );
  assert.ok(profile.includes(`${JSON.stringify(codexPath)}="read"`));
  assert.match(profile, /extends=":read-only"/);
  assert.ok(profile.includes(`${JSON.stringify(toolCacheDir)}="read"`));
  assert.match(profile, /network=\{enabled=false\}/);
  const cargoProfile = sandboxPermissionOverride({
    profileName: "test-cargo-profile",
    workspace,
    scratchDir,
    rtkPath,
    toolCacheDir,
    toolCacheAccess: "read",
    writableCargoLocks: true,
  });
  for (const name of [".package-cache", ".package-cache-mutate"]) {
    assert.ok(
      cargoProfile.includes(
        `${JSON.stringify(join(toolCacheDir, "cargo", name))}="write"`,
      ),
    );
  }
  const localProfile = sandboxPermissionOverride({
    profileName: "test-local-profile",
    workspace,
    scratchDir,
    rtkPath,
    allowLocalBinding: true,
  });
  assert.match(
    localProfile,
    /network=\{enabled=true,allow_local_binding=true\}/,
  );
  const reviewProfile = sandboxPermissionOverride({
    profileName: "test-review-profile",
    workspace,
    scratchDir,
    rtkPath,
    workspaceAccess: "read",
  });
  assert.match(reviewProfile, /extends=":read-only"/);
  assert.ok(reviewProfile.includes(`${JSON.stringify(workspace)}="read"`));
  const realWorkspaceProfile = sandboxPermissionOverride({
    profileName: "test-real-workspace-profile",
    workspace: root,
    scratchDir: tmpdir(),
    rtkPath,
    workspaceAccess: "read",
  });
  assert.ok(
    !realWorkspaceProfile.includes(
      `${JSON.stringify(join(root, "AGENTS.md"))}="deny"`,
    ),
  );
  const cargoBin = join(homedir(), ".cargo", "bin");
  if (existsSync(cargoBin)) {
    const cargoBinProfile = sandboxPermissionOverride({
      profileName: "test-cargo-bin-profile",
      workspace,
      scratchDir,
      rtkPath: join(cargoBin, "rtk"),
    });
    assert.equal(
      cargoBinProfile.includes(
        `${JSON.stringify(join(cargoBin, "cargo"))}="deny"`,
      ),
      false,
    );
  }
});

test("native lock wraps the entire maintenance worker", () => {
  const stateDir = join(tmpdir(), "y2-maintenance-state");
  const fingerprint = "f".repeat(64);
  const args = nativeLockArguments(
    stateDir,
    ["--force"],
    "/bin/node",
    fingerprint,
  );
  assert.deepEqual(args.slice(0, 5), [
    "-s",
    "-t",
    "0",
    "-k",
    join(stateDir, "run.lock"),
  ]);
  assert.equal(args[5], "/bin/node");
  assert.ok(args[6].endsWith(join("scripts", "y2-maintenance.mjs")));
  assert.deepEqual(args.slice(7), [
    "--native-lock-held",
    fingerprint,
    "--force",
  ]);
  assert.throws(
    () => nativeLockArguments(stateDir, [], "/bin/node", "short"),
    /fingerprint/,
  );
});

test("maintenance configuration fingerprints bind every operational path", () => {
  const configuration = {
    repoPath: "/repo",
    stateDir: "/state",
    cacheDir: "/cache",
    rtkPath: "/bin/rtk",
    codexPath: "/bin/codex",
    repoSlug: "owner/repo",
    originUrl: "https://github.com/owner/repo.git",
  };
  const fingerprint = maintenanceConfigurationFingerprint(configuration);
  assert.match(fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(
    maintenanceConfigurationFingerprint({ ...configuration }),
    fingerprint,
  );
  assert.notEqual(
    maintenanceConfigurationFingerprint({
      ...configuration,
      stateDir: "/other-state",
    }),
    fingerprint,
  );
});

test("model commands receive writable isolated home, temp, and cache paths", (t) => {
  const scratchDir = mkdtempSync(join(tmpdir(), "y2-model-environment-"));
  t.after(() => rmSync(scratchDir, { recursive: true, force: true }));
  const environment = modelEnvironment(scratchDir);
  assert.equal(environment.HOME, join(scratchDir, "home"));
  assert.equal(environment.TMPDIR, `${join(scratchDir, "tmp")}${sep}`);
  assert.equal(environment.TMP, join(scratchDir, "tmp"));
  assert.equal(environment.TEMP, join(scratchDir, "tmp"));
  assert.equal(environment.XDG_CACHE_HOME, join(scratchDir, "xdg-cache"));
  assert.equal(environment.CARGO_HOME, join(scratchDir, "cargo"));
  assert.equal(environment.npm_config_cache, join(scratchDir, "npm"));
  for (const path of [
    environment.HOME,
    environment.TMP,
    environment.XDG_CACHE_HOME,
    environment.CARGO_HOME,
    environment.npm_config_cache,
  ]) {
    assert.equal(existsSync(path), true, path);
  }
});
test("exact command output remains available without entering serialized reports", () => {
  const exact = "x".repeat(200_000);
  const record = retainExactStdout({ stdout: exact.slice(-96 * 1024) }, exact);
  assert.equal(record.fullStdout, exact);
  assert.equal(record.stdout.length, 96 * 1024);
  assert.doesNotMatch(JSON.stringify(record), /fullStdout/);
});

test("automated fixes are confined to reviewable source, test, localization, and docs paths", () => {
  for (const path of [
    "hifimule-daemon/src/sync.rs",
    "hifimule-ui/src/main.ts",
    "hifimule-ui/tests/local.test.mjs",
    "hifimule-i18n/catalog.json",
    "docs/maintenance.md",
    "scripts/tests/new-regression.test.mjs",
  ])
    assert.equal(isAllowedAutomatedFixPath(path), true, path);
  for (const path of [
    ".github/workflows/build.yml",
    "Cargo.toml",
    "Cargo.lock",
    "hifimule-i18n/Cargo.toml",
    "hifimule-ui/package-lock.json",
    "hifimule-ui/src-tauri/capabilities/default.json",
    "scripts/y2-maintenance.mjs",
    "scripts/tests/y2-maintenance.test.mjs",
    "../outside",
    "/absolute/path",
    "docs/control\tcharacter.md",
  ])
    assert.equal(isAllowedAutomatedFixPath(path), false, path);
});

test("only added tests executed by fixed gates are accepted", () => {
  for (const path of [
    "hifimule-ui/tests/nested/regression.test.mjs",
    "scripts/tests/nested/regression.test.mjs",
    "scripts/tests/test_regression.py",
  ]) {
    assert.equal(isRunnableAddedTestPath(path), true, path);
  }
  for (const path of [
    "hifimule-ui/tests/helper.js",
    "scripts/tests/nested/test_regression.py",
    "scripts/tests/regression.py",
  ]) {
    assert.equal(isRunnableAddedTestPath(path), false, path);
  }
  assert.throws(
    () =>
      validateAutomatedDiff({
        records: [{ status: "A", path: "scripts/tests/helper.js" }],
        summaries: " create mode 100644 scripts/tests/helper.js",
        patch: "safe diff",
        fileMetadata: {
          "scripts/tests/helper.js": {
            regular: true,
            symlink: false,
            size: 100,
          },
        },
      }),
    /not executed by a fixed gate/,
  );
});
test("remediation runs for a failed gate or a concrete medium-or-higher finding", () => {
  const passing = [{ id: "test", code: 0 }];
  assert.equal(shouldAttemptRemediation(passing, { findings: [] }), false);
  assert.equal(
    shouldAttemptRemediation([{ id: "test", code: 1 }], { findings: [] }),
    true,
  );
  assert.equal(
    shouldAttemptRemediation(passing, { findings: [{ severity: "low" }] }),
    false,
  );
  assert.equal(
    shouldAttemptRemediation(passing, { findings: [{ severity: "medium" }] }),
    true,
  );
});

test("deep diff validation permits source edits and new tests but rejects harness tampering", () => {
  const valid = [
    { status: "M", path: "hifimule-daemon/src/sync.rs" },
    { status: "A", path: "scripts/tests/new-regression.test.mjs" },
  ];
  const metadata = Object.fromEntries(
    valid.map(({ path }) => [
      path,
      { regular: true, symlink: false, size: 100 },
    ]),
  );
  assert.deepEqual(
    validateAutomatedDiff({
      records: valid,
      summaries: " create mode 100644 scripts/tests/new-regression.test.mjs",
      patch: "safe diff",
      fileMetadata: metadata,
    }),
    valid.map(({ path }) => path),
  );
  assert.throws(
    () =>
      validateAutomatedDiff({
        records: [{ status: "M", path: "scripts/tests/existing.test.mjs" }],
        summaries: "",
        patch: "safe diff",
        fileMetadata: {
          "scripts/tests/existing.test.mjs": {
            regular: true,
            symlink: false,
            size: 100,
          },
        },
      }),
    /cannot modify an existing test/,
  );
  assert.throws(
    () =>
      validateAutomatedDiff({
        records: [{ status: "M", path: "hifimule-daemon/src/sync.rs" }],
        summaries: " mode change 100644 => 100755 hifimule-daemon/src/sync.rs",
        patch: "safe diff",
        fileMetadata: {
          "hifimule-daemon/src/sync.rs": {
            regular: true,
            symlink: false,
            size: 100,
          },
        },
      }),
    /changes file identity/,
  );
  assert.throws(
    () =>
      validateAutomatedDiff({
        records: [{ status: "M", path: "hifimule-daemon/src/sync.rs" }],
        summaries: "",
        patch: "+Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz",
        fileMetadata: {
          "hifimule-daemon/src/sync.rs": {
            regular: true,
            symlink: false,
            size: 100,
          },
        },
      }),
    /secret-like value/,
  );
  assert.throws(
    () =>
      validateAutomatedDiff({
        records: [{ status: "M", path: "hifimule-daemon/src/sync.rs" }],
        summaries: "",
        patch: "safe diff",
        fileMetadata: {
          "hifimule-daemon/src/sync.rs": {
            regular: true,
            symlink: false,
            size: 100,
            baselineHasInlineTests: true,
          },
        },
      }),
    /inline tests/,
  );
  assert.throws(
    () =>
      validateAutomatedDiff({
        records: [
          { status: "M", path: "hifimule-daemon/src/rpc/album_tests.rs" },
        ],
        summaries: "",
        patch: "safe diff",
        fileMetadata: {
          "hifimule-daemon/src/rpc/album_tests.rs": {
            regular: true,
            symlink: false,
            size: 100,
            baselineHasInlineTests: false,
          },
        },
      }),
    /cannot modify an existing test/,
  );
});

test("Rust async and cfg-gated tests are immutable remediation inputs", () => {
  assert.equal(
    rustSourceContainsTests(
      "hifimule-daemon/src/rpc/album_tests.rs",
      '#[tokio::test(flavor = "multi_thread")] async fn works() {}',
    ),
    true,
  );
  assert.equal(
    rustSourceContainsTests(
      "hifimule-daemon/src/helper.rs",
      "#[cfg(all(test, unix))] mod checks {}",
    ),
    true,
  );
});

test("gate, remediation, and validation workspaces are physically distinct", () => {
  const plan = maintenanceWorkspacePlan(join(tmpdir(), "maintenance-run"));
  assert.equal(new Set(Object.values(plan)).size, 3);
  assert.notEqual(plan.initialGates, plan.remediation);
});

test("exact patch statistics cannot substitute a protected or omitted path", () => {
  const paths = parsePatchNumstat(
    "4\t1\thifimule-daemon/src/sync.rs\0" +
      "8\t0\tscripts/tests/new-regression.test.mjs\0",
  );
  assert.deepEqual(paths, [
    "hifimule-daemon/src/sync.rs",
    "scripts/tests/new-regression.test.mjs",
  ]);
  assert.doesNotThrow(() => assertExactPatchPaths(paths, [...paths]));
  assert.throws(
    () => assertExactPatchPaths(paths, ["Cargo.toml", paths[1]]),
    /exact patch paths/,
  );
  assert.throws(
    () => parsePatchNumstat("-\t-\thifimule-daemon/src/sync.rs\0"),
    /binary patch statistics/,
  );
});

test("secret scanning covers added private keys and common provider credentials only", () => {
  assert.equal(
    addedPatchContainsSecret(
      "-Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz\n+replacement",
    ),
    false,
  );
  assert.equal(
    addedPatchContainsSecret("+-----BEGIN OPENSSH PRIVATE KEY-----"),
    true,
  );
  assert.equal(
    addedPatchContainsSecret("+-----BEGIN ENCRYPTED PRIVATE KEY-----"),
    true,
  );
  assert.equal(
    addedPatchContainsSecret("+-----BEGIN PGP PRIVATE KEY BLOCK-----"),
    true,
  );
  assert.equal(
    addedPatchContainsSecret(
      "+aws_secret_access_key=abcdefghijklmnopqrstuvwxyz123456",
    ),
    true,
  );
});

test("post-gate validation requires the exact staged patch and no other changes", () => {
  const valid = {
    expectedPatch: "patch",
    stagedPatch: "patch",
    unstagedPatch: "",
    untracked: [],
  };
  assert.doesNotThrow(() => assertExactValidatedPatch(valid));
  assert.throws(
    () => assertExactValidatedPatch({ ...valid, stagedPatch: "changed" }),
    /exact validated patch/,
  );
  assert.throws(
    () => assertExactValidatedPatch({ ...valid, untracked: ["extra.txt"] }),
    /exact validated patch/,
  );
});

test("maintenance branch names are deterministic, bounded, and revision-specific", () => {
  const branch = maintenanceBranchName(
    sha,
    new Date("2026-09-24T12:34:56.000Z"),
  );
  assert.equal(branch, "automation/maintenance-20260924t123456z-aaaaaaaa");
  assert.throws(() => maintenanceBranchName("short"), /full commit ID/);
});

test("the fixed quality plan covers formatting, UI, scripts, Rust, and dependency audit", () => {
  const plan = maintenanceGatePlan(root);
  assert.deepEqual(
    plan.map((gate) => gate.id),
    [
      "diff-check",
      "rustfmt",
      "ui-install",
      "node-tests",
      "python-tests",
      "ui-build",
      "audio-fixtures",
      "cargo-fetch",
      "audio-source-fetch",
      "audio-source-verify",
      "daemon-check",
      "local-network-probe",
      "daemon-tests",
      "support-tests",
      "npm-audit",
    ],
  );
  const nodeGate = plan.find((gate) => gate.id === "node-tests");
  assert.ok(
    nodeGate.args.some((value) =>
      value.endsWith(join("scripts", "tests", "y2-maintenance.test.mjs")),
    ),
  );
  assert.deepEqual(plan.find((gate) => gate.id === "audio-fixtures").args, [
    "proxy",
    "python3",
    "experiments/playback-probe/generate-fixtures.py",
  ]);
  assert.deepEqual(
    plan.find((gate) => gate.id === "cargo-fetch"),
    {
      id: "cargo-fetch",
      args: ["cargo", "fetch", "--locked"],
      network: true,
      cacheWrite: true,
    },
  );
  const audioFetch = plan.find((gate) => gate.id === "audio-source-fetch");
  assert.equal(audioFetch.network, true);
  assert.ok(
    audioFetch.args.includes("https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz"),
  );
  assert.ok(audioFetch.args.includes("=https"));
  const audioVerify = plan.find((gate) => gate.id === "audio-source-verify");
  assert.notEqual(audioVerify.network, true);
  assert.ok(
    audioVerify.args.includes(
      "8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e",
    ),
  );
  assert.equal(
    plan.find((gate) => gate.id === "local-network-probe").localNetwork,
    true,
  );
  for (const id of ["daemon-tests", "support-tests"]) {
    assert.equal(plan.find((gate) => gate.id === id).localNetwork, true);
  }
  for (const id of ["daemon-check", "daemon-tests", "support-tests"]) {
    assert.equal(plan.find((gate) => gate.id === id).cargoOffline, true);
    assert.notEqual(plan.find((gate) => gate.id === id).network, true);
  }
  assert.ok(
    plan.every((gate) => Array.isArray(gate.args) && gate.args.length > 1),
  );
});

test("launchd configuration uses fixed arguments, least-privilege files, and no shell", () => {
  const fixtureRoot = join(tmpdir(), "Y2 & Sync");
  const configuration = maintenanceConfiguration({
    repoPath: fixtureRoot,
    rtkPath: join(fixtureRoot, "bin", "rtk"),
    codexPath: join(fixtureRoot, "bin", "codex"),
    nodePath: join(fixtureRoot, "bin", "node"),
    repoSlug: "owner/repo",
    originUrl: "https://github.com/owner/repo.git",
    gitWatchPath: join(fixtureRoot, "git-common", "logs", "HEAD"),
    stateDir: join(fixtureRoot, "state"),
    cacheDir: join(fixtureRoot, "cache"),
  });
  const plist = buildMaintenancePlist(configuration, { intervalSeconds: 3600 });
  assert.match(plist, /<integer>3600<\/integer>/);
  assert.match(plist, /Y2 &amp; Sync/);
  assert.ok(plist.includes(xmlEscape(configuration.gitWatchPath)));
  assert.ok(plist.includes(xmlEscape(configuration.nodePath)));
  assert.ok(
    plist.includes(
      xmlEscape(join(configuration.repoPath, "scripts", "y2-maintenance.mjs")),
    ),
  );
  assert.ok(plist.includes(xmlEscape(join(homedir(), ".cargo", "bin"))));
  assert.match(plist, /<key>Umask<\/key>\s*<integer>63<\/integer>/);
  assert.match(plist, /<key>LowPriorityIO<\/key>\s*<true\/>/);
  assert.doesNotMatch(plist, /\/bin\/(?:ba|z|fi)?sh<\/string>/);
  assert.doesNotMatch(plist, /KeepAlive/);
  assert.equal(xmlEscape("<&\"'>"), "&lt;&amp;&quot;&apos;&gt;");
  assert.throws(
    () => buildMaintenancePlist(configuration, { intervalSeconds: 60 }),
    /at least 900/,
  );
});

test("scheduled installation requires a full-history repository", () => {
  assert.doesNotThrow(() => requireFullHistory("false\n"));
  assert.throws(() => requireFullHistory("true\n"), /full-history/);
  assert.throws(() => requireFullHistory("unknown"), /full-history/);
});
test("the Codex review schema is strict and bounded", () => {
  const schema = JSON.parse(
    readFileSync(
      join(root, "scripts", "maintenance-review.schema.json"),
      "utf8",
    ),
  );
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.findings.maxItems, 10);
  assert.deepEqual(schema.properties.findings.items.properties.severity.enum, [
    "critical",
    "high",
    "medium",
    "low",
  ]);
});

test("draft maintenance pull requests cannot execute repository code in CI", () => {
  const workflow = readFileSync(
    join(root, ".github", "workflows", "build.yml"),
    "utf8",
  );
  assert.match(
    workflow,
    /types: \[opened, synchronize, reopened, ready_for_review\]/,
  );
  assert.match(
    workflow,
    /github\.event_name != 'pull_request' \|\| github\.event\.pull_request\.draft == false/,
  );
});
