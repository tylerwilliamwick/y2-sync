#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultCacheDir,
  defaultStateDir,
  maintenanceLabel,
  maintenanceSchemaVersion,
  parseGitHubOrigin,
  redactText,
  resolveApprovedExecutable,
} from "./y2-maintenance.mjs";

const projectRoot = resolve(import.meta.dirname, "..");
const launchAgentsDir = join(homedir(), "Library", "LaunchAgents");
export const maintenancePlistPath = join(
  launchAgentsDir,
  `${maintenanceLabel}.plist`,
);
export const maintenanceConfigPath = join(defaultStateDir, "config.json");
const launchDomain = `gui/${process.getuid?.() ?? -1}`;
const maintenanceRuntimePointerName = "runtime.json";
export function maintenanceRuntimePaths(stateDir, digest) {
  if (!/^[a-f0-9]{64}$/.test(digest ?? ""))
    throw new Error("maintenance runtime digest is invalid");
  const root = join(resolve(stateDir), "runtime");
  const bundle = join(root, "versions", digest);
  return {
    root,
    bundle,
    pointer: join(resolve(stateDir), maintenanceRuntimePointerName),
    runner: join(bundle, "scripts", "y2-maintenance.mjs"),
    schema: join(bundle, "scripts", "maintenance-review.schema.json"),
  };
}

export function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function requireFullHistory(value) {
  if (String(value).trim() !== "false") {
    throw new Error(
      "scheduled maintenance requires a full-history repository; unshallow the clone before installation",
    );
  }
}

function run(rtkPath, args, options = {}) {
  const result = spawnSync(rtkPath, args, {
    cwd: options.cwd ?? projectRoot,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 4 * 1024 * 1024,
    timeout: options.timeoutMs ?? 60_000,
  });
  if (options.check && result.status !== 0) {
    const detail = redactText(
      result.stderr || result.stdout || `exit ${result.status}`,
    );
    throw new Error(`${args.join(" ")} failed: ${detail.trim()}`);
  }
  return result;
}

function resolveRepository(repoPath, rtkPath) {
  const root = resolve(repoPath);
  const inside = run(
    rtkPath,
    ["proxy", "git", "rev-parse", "--is-inside-work-tree"],
    { cwd: root, check: true },
  );
  if (inside.stdout.trim() !== "true")
    throw new Error(`${root} is not a Git worktree`);
  const shallow = run(
    rtkPath,
    ["proxy", "git", "rev-parse", "--is-shallow-repository"],
    { cwd: root, check: true },
  );
  requireFullHistory(shallow.stdout);
  const origin = run(rtkPath, ["proxy", "git", "remote", "get-url", "origin"], {
    cwd: root,
    check: true,
  });
  const headLog = run(
    rtkPath,
    [
      "proxy",
      "git",
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "logs/HEAD",
    ],
    { cwd: root, check: true },
  );
  const gitWatchPath = resolve(root, headLog.stdout.trim());
  if (!existsSync(gitWatchPath) || !statSync(gitWatchPath).isFile()) {
    throw new Error("could not resolve the repository HEAD reflog");
  }
  return { root, gitWatchPath, ...parseGitHubOrigin(origin.stdout.trim()) };
}

export function maintenanceConfiguration({
  repoPath,
  rtkPath,
  codexPath,
  nodePath = process.execPath,
  repoSlug,
  originUrl,
  gitWatchPath = join(resolve(repoPath), ".git", "logs", "HEAD"),
  stateDir = defaultStateDir,
  cacheDir = defaultCacheDir,
}) {
  return {
    schemaVersion: maintenanceSchemaVersion,
    repoPath: resolve(repoPath),
    rtkPath: resolve(rtkPath),
    codexPath: resolve(codexPath),
    nodePath: resolve(nodePath),
    repoSlug,
    originUrl,
    gitWatchPath: resolve(gitWatchPath),
    stateDir: resolve(stateDir),
    cacheDir: resolve(cacheDir),
  };
}

export function buildMaintenancePlist(configuration, options = {}) {
  const intervalSeconds = options.intervalSeconds ?? 21_600;
  if (!Number.isSafeInteger(intervalSeconds) || intervalSeconds < 900) {
    throw new Error(
      "maintenance interval must be an integer of at least 900 seconds",
    );
  }
  const runnerPath = resolve(options.runnerPath ?? "");
  const runtimeRoot = join(resolve(configuration.stateDir), "runtime");
  if (!options.runnerPath || !runnerPath.startsWith(`${runtimeRoot}${sep}`)) {
    throw new Error("installed maintenance runner path is invalid");
  }
  const pathEntries = [
    dirname(configuration.nodePath),
    dirname(configuration.rtkPath),
    dirname(configuration.codexPath),
    join(homedir(), ".cargo", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  const executablePath = [...new Set(pathEntries)].join(":");
  const outPath = join(configuration.stateDir, "launchd.stdout.log");
  const errorPath = join(configuration.stateDir, "launchd.stderr.log");
  const watchPath = configuration.gitWatchPath;
  const values = {
    label: maintenanceLabel,
    node: configuration.nodePath,
    runner: runnerPath,
    config: maintenanceConfigPath,
    cwd: configuration.repoPath,
    path: executablePath,
    out: outPath,
    error: errorPath,
    watch: watchPath,
  };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(values.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(values.node)}</string>
    <string>${xmlEscape(values.runner)}</string>
    <string>--config</string>
    <string>${xmlEscape(values.config)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(values.cwd)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(values.path)}</string>
    <key>NO_COLOR</key>
    <string>1</string>
    <key>GIT_TERMINAL_PROMPT</key>
    <string>0</string>
  </dict>
  <key>StartInterval</key>
  <integer>${intervalSeconds}</integer>
  <key>WatchPaths</key>
  <array>
    <string>${xmlEscape(values.watch)}</string>
  </array>
  <key>ThrottleInterval</key>
  <integer>900</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>LowPriorityIO</key>
  <true/>
  <key>Nice</key>
  <integer>10</integer>
  <key>Umask</key>
  <integer>63</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(values.out)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(values.error)}</string>
</dict>
</plist>
`;
}

export function installMaintenanceRuntime(configuration) {
  const sources = [
    {
      source: join(
        resolve(configuration.repoPath),
        "scripts",
        "y2-maintenance.mjs",
      ),
      name: "y2-maintenance.mjs",
    },
    {
      source: join(
        resolve(configuration.repoPath),
        "scripts",
        "maintenance-review.schema.json",
      ),
      name: "maintenance-review.schema.json",
    },
  ];
  const contents = sources.map(({ source, name }) => {
    const metadata = lstatSync(source);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(
        `maintenance runtime source is not a regular file: ${source}`,
      );
    }
    return { name, value: readFileSync(source) };
  });
  const digestHash = createHash("sha256");
  for (const { name, value } of contents) {
    digestHash.update(`${name}\0${value.length}\0`);
    digestHash.update(value);
  }
  const digest = digestHash.digest("hex");
  const paths = maintenanceRuntimePaths(configuration.stateDir, digest);
  const versionsRoot = dirname(paths.bundle);
  const stagingRoot = join(
    versionsRoot,
    `.tmp-${process.pid}-${digest.slice(0, 12)}`,
  );
  mkdirSync(configuration.stateDir, { recursive: true, mode: 0o700 });
  const stateMetadata = lstatSync(configuration.stateDir);
  if (
    !stateMetadata.isDirectory() ||
    stateMetadata.isSymbolicLink() ||
    resolve(realpathSync(configuration.stateDir)) !==
      resolve(configuration.stateDir)
  ) {
    throw new Error("maintenance state directory cannot be a symbolic link");
  }
  chmodSync(configuration.stateDir, 0o700);
  for (const directory of [paths.root, versionsRoot]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const metadata = lstatSync(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("maintenance runtime path cannot contain symbolic links");
    }
    chmodSync(directory, 0o700);
  }
  rmSync(stagingRoot, { recursive: true, force: true });
  mkdirSync(join(stagingRoot, "scripts"), {
    recursive: true,
    mode: 0o700,
  });
  for (const { name, value } of contents) {
    const destination = join(stagingRoot, "scripts", name);
    writeFileSync(destination, value, {
      flag: "wx",
      mode: 0o600,
    });
    chmodSync(destination, 0o600);
  }
  if (!existsSync(paths.bundle)) {
    renameSync(stagingRoot, paths.bundle);
  } else {
    const metadata = lstatSync(paths.bundle);
    rmSync(stagingRoot, { recursive: true, force: true });
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("installed maintenance runtime bundle is invalid");
    }
  }
  for (const directory of [paths.bundle, dirname(paths.runner)]) {
    const metadata = lstatSync(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("installed maintenance runtime bundle is invalid");
    }
  }
  for (const { name, value } of contents) {
    const installedPath = join(paths.bundle, "scripts", name);
    const metadata = lstatSync(installedPath);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      !readFileSync(installedPath).equals(value)
    ) {
      throw new Error("installed maintenance runtime bundle failed validation");
    }
  }
  const temporaryPointer = `${paths.pointer}.tmp-${process.pid}`;
  rmSync(temporaryPointer, { force: true });
  writeFileSync(
    temporaryPointer,
    `${JSON.stringify({ schemaVersion: maintenanceSchemaVersion, digest }, null, 2)}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  chmodSync(temporaryPointer, 0o600);
  renameSync(temporaryPointer, paths.pointer);
  chmodSync(paths.pointer, 0o600);
  return paths;
}

function readInstalledRuntime(stateDir) {
  const pointer = join(resolve(stateDir), maintenanceRuntimePointerName);
  const metadata = lstatSync(pointer);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("installed maintenance runtime pointer is invalid");
  }
  const value = JSON.parse(readFileSync(pointer, "utf8"));
  if (
    value?.schemaVersion !== maintenanceSchemaVersion ||
    Object.keys(value).sort().join(",") !== "digest,schemaVersion"
  ) {
    throw new Error("installed maintenance runtime pointer is invalid");
  }
  const paths = maintenanceRuntimePaths(stateDir, value.digest);
  for (const directory of [
    paths.root,
    dirname(paths.bundle),
    paths.bundle,
    dirname(paths.runner),
  ]) {
    const directoryMetadata = lstatSync(directory);
    if (
      !directoryMetadata.isDirectory() ||
      directoryMetadata.isSymbolicLink()
    ) {
      throw new Error(
        "installed maintenance runtime is unavailable; reinstall it",
      );
    }
  }
  const runnerMetadata = lstatSync(paths.runner);
  if (!runnerMetadata.isFile() || runnerMetadata.isSymbolicLink()) {
    throw new Error(
      "installed maintenance runtime is unavailable; reinstall it",
    );
  }
  return paths;
}

function writeConfiguration(configuration) {
  mkdirSync(configuration.stateDir, { recursive: true, mode: 0o700 });
  chmodSync(configuration.stateDir, 0o700);
  const temporary = `${maintenanceConfigPath}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(configuration, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(temporary, 0o600);
  renameSync(temporary, maintenanceConfigPath);
  chmodSync(maintenanceConfigPath, 0o600);
}

function install(repoPath) {
  if (process.platform !== "darwin")
    throw new Error(
      "the local scheduled-maintenance installer currently supports macOS launchd only",
    );
  if (!Number.isSafeInteger(process.getuid?.()) || process.getuid() < 1)
    throw new Error("could not resolve the GUI user ID");
  const rtkPath = resolveApprovedExecutable("rtk");
  const codexPath = resolveApprovedExecutable("codex");
  const nodePath = resolveApprovedExecutable("node");
  const repository = resolveRepository(repoPath, rtkPath);
  const selectedRunner = join(repository.root, "scripts", "y2-maintenance.mjs");
  if (!existsSync(selectedRunner) || !statSync(selectedRunner).isFile()) {
    throw new Error(
      "selected repository does not contain the maintenance runner",
    );
  }
  const configuration = maintenanceConfiguration({
    repoPath: repository.root,
    rtkPath,
    codexPath,
    nodePath,
    repoSlug: repository.slug,
    originUrl: repository.url,
    gitWatchPath: repository.gitWatchPath,
  });
  run(rtkPath, [
    "proxy",
    "launchctl",
    "bootout",
    launchDomain,
    maintenancePlistPath,
  ]);
  const runtime = installMaintenanceRuntime(configuration);
  writeConfiguration(configuration);
  mkdirSync(launchAgentsDir, { recursive: true, mode: 0o755 });
  writeFileSync(
    maintenancePlistPath,
    buildMaintenancePlist(configuration, { runnerPath: runtime.runner }),
    { encoding: "utf8", mode: 0o644 },
  );
  chmodSync(maintenancePlistPath, 0o644);
  run(rtkPath, ["proxy", "plutil", "-lint", maintenancePlistPath], {
    check: true,
  });
  run(
    rtkPath,
    ["proxy", "launchctl", "bootstrap", launchDomain, maintenancePlistPath],
    { check: true },
  );
  run(
    rtkPath,
    ["proxy", "launchctl", "enable", `${launchDomain}/${maintenanceLabel}`],
    { check: true },
  );
  console.log(
    `Installed ${maintenanceLabel}; runs every 6 hours with best-effort local-commit triggers.`,
  );
  console.log(`Configuration: ${maintenanceConfigPath}`);
  return configuration;
}

function uninstall() {
  const rtkPath = resolveApprovedExecutable("rtk");
  run(rtkPath, [
    "proxy",
    "launchctl",
    "bootout",
    launchDomain,
    maintenancePlistPath,
  ]);
  rmSync(maintenancePlistPath, { force: true });
  rmSync(maintenanceConfigPath, { force: true });
  rmSync(join(defaultStateDir, "runtime"), { recursive: true, force: true });
  rmSync(join(defaultStateDir, maintenanceRuntimePointerName), { force: true });
  console.log(
    `Uninstalled ${maintenanceLabel}. Existing maintenance reports were retained.`,
  );
}

function status() {
  const rtkPath = resolveApprovedExecutable("rtk");
  const result = run(rtkPath, [
    "proxy",
    "launchctl",
    "print",
    `${launchDomain}/${maintenanceLabel}`,
  ]);
  if (result.status === 0) process.stdout.write(result.stdout);
  else console.log(`${maintenanceLabel} is not loaded.`);
  const statePath = join(defaultStateDir, "state.json");
  if (existsSync(statePath))
    process.stdout.write(readFileSync(statePath, "utf8"));
}

function runNow(extraArgs) {
  if (!existsSync(maintenanceConfigPath))
    throw new Error("install the maintenance agent before running it");
  const configuration = JSON.parse(readFileSync(maintenanceConfigPath, "utf8"));
  const runtime = readInstalledRuntime(configuration.stateDir);
  const result = run(
    configuration.rtkPath,
    [
      "proxy",
      configuration.nodePath,
      runtime.runner,
      "--config",
      maintenanceConfigPath,
      ...extraArgs,
    ],
    { cwd: configuration.repoPath, timeoutMs: 3 * 60 * 60 * 1000 },
  );
  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");
  return result.status ?? 1;
}

function usage() {
  return "Usage: node scripts/install-y2-maintenance.mjs <install|uninstall|status|run> [--repo PATH] [--force] [--audit-only] [--skip-review]";
}

export function installerMain(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  let repoPath = projectRoot;
  const forwarded = [];
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === "--repo") {
      if (!rest[index + 1]) throw new Error("--repo requires a path");
      repoPath = resolve(rest[index + 1]);
      index += 1;
    } else forwarded.push(rest[index]);
  }
  if (command === "install") {
    if (forwarded.length)
      throw new Error(`install does not accept: ${forwarded.join(" ")}`);
    install(repoPath);
    return 0;
  }
  if (command === "uninstall") {
    if (rest.length)
      throw new Error("uninstall does not accept additional arguments");
    uninstall();
    return 0;
  }
  if (command === "status") {
    if (rest.length)
      throw new Error("status does not accept additional arguments");
    status();
    return 0;
  }
  if (command === "run") return runNow(forwarded);
  throw new Error(usage());
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  try {
    process.exitCode = installerMain();
  } catch (error) {
    console.error(
      `Y2 maintenance installer failed: ${redactText(error instanceof Error ? error.message : error)}`,
    );
    process.exitCode = 1;
  }
}
