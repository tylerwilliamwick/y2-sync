#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const maintenanceSchemaVersion = 1;
export const maintenanceLabel = "com.tylerwick.y2-sync-maintenance";
export const defaultStateDir = join(
  homedir(),
  "Library",
  "Application Support",
  "Y2 Sync Maintenance",
);
export const defaultCacheDir = join(tmpdir(), "Y2SyncMaintenanceTooling");
const projectRoot = resolve(import.meta.dirname, "..");
const reviewSchemaPath = join(
  projectRoot,
  "scripts",
  "maintenance-review.schema.json",
);
const maxCommandOutput = 96 * 1024;
const maxReviewBytes = 256 * 1024;
const defaultCommandTimeoutMs = 30 * 60 * 1000;
const longBuildTimeoutMs = 45 * 60 * 1000;
const codexTimeoutMs = 45 * 60 * 1000;
const nativeLockMarker = "--native-lock-held";
const managedSubprocessMarker = "--managed-subprocess";
const managedSubprocessGraceMs = 15_000;
const managedSubprocessKillGraceMs = 5_000;
const verifySha256Program = [
  'const { createHash } = require("node:crypto");',
  'const { readFileSync, statSync } = require("node:fs");',
  "const [path, expected] = process.argv.slice(1);",
  'if (statSync(path).size > 100 * 1024 * 1024) throw new Error("audio source archive exceeds 100 MiB");',
  'const actual = createHash("sha256").update(readFileSync(path)).digest("hex");',
  "if (actual !== expected) throw new Error(`audio source checksum mismatch: ${actual}`);",
].join("");
const localNetworkProbeProgram = [
  'const net = require("node:net");',
  'const { spawnSync } = require("node:child_process");',
  'const timer = setTimeout(() => { console.error("local network probe timed out"); process.exit(1); }, 10000);',
  'const server = net.createServer((socket) => socket.end("ok"));',
  'server.listen(0, "127.0.0.1", () => {',
  'let body = "";',
  'const socket = net.connect({ host: "127.0.0.1", port: server.address().port });',
  'socket.on("data", (chunk) => { body += chunk; });',
  'socket.on("error", (error) => { console.error(error.message); process.exit(1); });',
  'socket.on("end", () => {',
  "server.close();",
  'if (body !== "ok") { console.error("loopback response mismatch"); process.exit(1); }',
  'const external = spawnSync("curl", ["--silent", "--show-error", "--max-time", "3", "https://example.com"], { encoding: "utf8" });',
  'if (external.status === 0 || !external.stderr.includes("response 403")) { console.error("external network was not denied by the managed proxy"); process.exit(1); }',
  "clearTimeout(timer);",
  'console.log("loopback allowed; external network denied by managed proxy");',
  "});",
  "});",
].join("");

const allowedSourceFixPrefixes = [
  "docs/",
  "hifimule-daemon/src/",
  "hifimule-i18n/src/",
  "hifimule-lifecycle/src/",
  "hifimule-ui/src/",
];

const allowedTestPrefixes = ["hifimule-ui/tests/", "scripts/tests/"];

const allowedFixPrefixes = [
  ...allowedSourceFixPrefixes,
  ...allowedTestPrefixes,
];

const allowedFixFiles = new Set(["hifimule-i18n/catalog.json"]);

const protectedFixPaths = new Set([
  "scripts/tests/y2-maintenance.test.mjs",
  "scripts/y2-maintenance.mjs",
  "scripts/install-y2-maintenance.mjs",
  "scripts/maintenance-review.schema.json",
]);

function nowIso() {
  return new Date().toISOString();
}

function safeError(error) {
  return redactText(error instanceof Error ? error.message : String(error));
}

export function redactText(value) {
  return String(value ?? "")
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, "$1[REDACTED]@")
    .replace(
      /\b(?:gh[opsu]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
      "[REDACTED_GITHUB_TOKEN]",
    )
    .replace(/\b(?:sk-[A-Za-z0-9_-]{20,})\b/g, "[REDACTED_API_KEY]")
    .replace(
      /(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,;]+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /((?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s,;]+/gi,
      "$1[REDACTED]",
    );
}

export function sanitizedEnvironment(environment = process.env, options = {}) {
  const allowed = new Set([
    "PATH",
    "HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "TZ",
    "USER",
    "LOGNAME",
    "CI",
    "CODEX_HOME",
    "CARGO_HOME",
    "RUSTUP_HOME",
    "CARGO_NET_OFFLINE",
    "CARGO_TERM_COLOR",
    "npm_config_cache",
    "npm_config_globalconfig",
    "npm_config_userconfig",
    "XDG_CACHE_HOME",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    "CURL_CA_BUNDLE",
    "DEVELOPER_DIR",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
  ]);
  const credentialKeys = new Set();
  if (options.allowCredentials) {
    for (const key of [
      "GH_CONFIG_DIR",
      "GH_HOST",
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "SSH_AUTH_SOCK",
      "XDG_CONFIG_HOME",
    ]) {
      allowed.add(key);
      credentialKeys.add(key);
    }
  }
  const clean = {};
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) continue;
    if (
      !allowed.has(key) ||
      /^GIT_/i.test(key) ||
      (!credentialKeys.has(key) &&
        /(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|ACCESS_KEY|SESSION_KEY|SSH_AUTH_SOCK|GPG_AGENT)/i.test(
          key,
        ))
    )
      continue;
    clean[key] = value;
  }
  clean.GIT_TERMINAL_PROMPT = "0";
  clean.GIT_ATTR_NOSYSTEM = "1";
  clean.GIT_LITERAL_PATHSPECS = "1";
  clean.GIT_OPTIONAL_LOCKS = "0";
  clean.CARGO_TERM_COLOR = "never";
  clean.NO_COLOR = "1";
  if (!options.allowCredentials) {
    clean.GH_CONFIG_DIR = join(defaultStateDir, "credentialless-gh");
    clean.GIT_CONFIG_GLOBAL = "/dev/null";
    clean.GIT_CONFIG_NOSYSTEM = "1";
  }
  return clean;
}

export function resolveApprovedExecutable(name, configuredPath = null) {
  const candidates = configuredPath
    ? [resolve(configuredPath)]
    : [
        join(homedir(), ".local", "bin", name),
        join(homedir(), ".cargo", "bin", name),
        join("/opt/homebrew/bin", name),
        join("/usr/local/bin", name),
        join("/usr/bin", name),
        join(dirname(process.execPath), name),
      ];
  const found = [...new Set(candidates)].find(
    (path) => existsSync(path) && statSync(path).isFile(),
  );
  if (!found)
    throw new Error(
      `${name} executable is unavailable in an approved location`,
    );
  return resolve(found);
}

export function parseGitHubOrigin(value) {
  const source = String(value ?? "").trim();
  const patterns = [
    {
      pattern:
        /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/,
      url: (slug) => `https://github.com/${slug}.git`,
    },
    {
      pattern:
        /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/,
      url: (slug) => `git@github.com:${slug}.git`,
    },
    {
      pattern:
        /^ssh:\/\/git@github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/,
      url: (slug) => `ssh://git@github.com/${slug}.git`,
    },
  ];
  for (const candidate of patterns) {
    const match = source.match(candidate.pattern);
    if (!match) continue;
    const slug = `${match[1]}/${match[2]}`;
    return { slug, url: candidate.url(slug) };
  }
  throw new Error(
    "origin must be an HTTPS or SSH github.com repository URL without embedded credentials",
  );
}

export function parseMaintenanceArgs(argv = process.argv.slice(2)) {
  const result = {
    configPath: null,
    repoPath: projectRoot,
    force: false,
    auditOnly: false,
    skipReview: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--force") result.force = true;
    else if (argument === "--audit-only") result.auditOnly = true;
    else if (argument === "--skip-review") result.skipReview = true;
    else if (argument === "--config" || argument === "--repo") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--"))
        throw new Error(`${argument} requires a path`);
      index += 1;
      if (argument === "--config") result.configPath = resolve(value);
      else result.repoPath = resolve(value);
    } else {
      throw new Error(`unknown maintenance argument: ${argument}`);
    }
  }
  return result;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function canonicalProspectivePath(path) {
  const suffix = [];
  let cursor = resolve(path);
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor)
      throw new Error(`could not resolve an existing ancestor for ${path}`);
    suffix.push(basename(cursor));
    cursor = parent;
  }
  return resolve(realpathSync(cursor), ...suffix.reverse());
}

export function resolveContainedDirectory(candidate, expectedRoot, label) {
  const target = resolve(candidate);
  const root = resolve(expectedRoot);
  const canonicalTarget = canonicalProspectivePath(target);
  const canonicalRoot = canonicalProspectivePath(root);
  if (
    canonicalTarget !== canonicalRoot &&
    !canonicalTarget.startsWith(`${canonicalRoot}${sep}`)
  ) {
    throw new Error(`${label} resolves outside its dedicated directory`);
  }
  const prefixes = [];
  let cursor = target;
  while (true) {
    prefixes.unshift(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  const boundaryIndex = prefixes.findIndex(
    (path) => canonicalProspectivePath(path) === canonicalRoot,
  );
  if (boundaryIndex < 0)
    throw new Error(`${label} could not resolve its dedicated directory`);
  for (const path of new Set([root, ...prefixes.slice(boundaryIndex)])) {
    let metadata;
    try {
      metadata = lstatSync(path);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (metadata.isSymbolicLink())
      throw new Error(`${label} cannot contain symbolic links`);
    if (!metadata.isDirectory())
      throw new Error(`${label} must contain only directories`);
  }
  return target;
}

export function validatedAudioRuntimeSource(
  workspace,
  suppliedManifest = null,
) {
  const manifest =
    suppliedManifest ??
    readJson(join(workspace, "hifimule-daemon", "audio-runtime.json"));
  const release = String(manifest.ffmpegRelease ?? "");
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(release))
    throw new Error("audio runtime release is invalid");
  const sourceUrl = `https://ffmpeg.org/releases/ffmpeg-${release}.tar.xz`;
  if (manifest.sourceUrl !== sourceUrl)
    throw new Error(
      "audio runtime source must use the canonical ffmpeg.org release URL",
    );
  const sourceSha256 = String(manifest.sourceSha256 ?? "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sourceSha256))
    throw new Error("audio runtime source SHA-256 is invalid");
  return {
    sourceUrl,
    sourceSha256,
    archivePath: join(
      resolve(workspace),
      "target",
      "audio-runtime",
      "sources",
      `ffmpeg-${release}.tar.xz`,
    ),
  };
}

function loadConfiguration(args) {
  const loaded = args.configPath ? readJson(args.configPath) : {};
  const allowed = new Set([
    "schemaVersion",
    "repoPath",
    "rtkPath",
    "codexPath",
    "nodePath",
    "repoSlug",
    "originUrl",
    "gitWatchPath",
    "stateDir",
    "cacheDir",
  ]);
  const unknown = Object.keys(loaded).filter((key) => !allowed.has(key));
  if (unknown.length)
    throw new Error(
      `unknown maintenance configuration fields: ${unknown.join(", ")}`,
    );
  if (
    loaded.schemaVersion !== undefined &&
    loaded.schemaVersion !== maintenanceSchemaVersion
  ) {
    throw new Error(
      `unsupported maintenance configuration schema: ${loaded.schemaVersion}`,
    );
  }
  const repoPath = resolve(loaded.repoPath ?? args.repoPath);
  const expectedStateRoot = resolve(defaultStateDir);
  const stateDir = resolveContainedDirectory(
    loaded.stateDir ?? defaultStateDir,
    expectedStateRoot,
    "maintenance stateDir",
  );
  const expectedCacheRoot = resolve(defaultCacheDir);
  const cacheDir = resolveContainedDirectory(
    loaded.cacheDir ?? defaultCacheDir,
    expectedCacheRoot,
    "maintenance cacheDir",
  );
  if (/\s/.test(cacheDir))
    throw new Error(
      "maintenance cacheDir cannot contain whitespace because native build tools do not support it",
    );
  const rtkPath = resolveApprovedExecutable("rtk", loaded.rtkPath);
  // Codex re-executes itself inside the selected sandbox while loading
  // repository instructions. Seatbelt cannot execute the user-home symlink
  // through a denied parent, so resolve only the runtime copy on each run.
  const codexPath = realpathSync(
    resolveApprovedExecutable("codex", loaded.codexPath),
  );
  const configuredOrigin = loaded.originUrl
    ? parseGitHubOrigin(loaded.originUrl)
    : null;
  if (
    loaded.repoSlug &&
    configuredOrigin &&
    loaded.repoSlug !== configuredOrigin.slug
  ) {
    throw new Error("configured repoSlug does not match originUrl");
  }
  return {
    repoPath,
    stateDir,
    cacheDir,
    rtkPath,
    codexPath,
    repoSlug: loaded.repoSlug ?? configuredOrigin?.slug ?? null,
    originUrl: configuredOrigin?.url ?? null,
  };
}

export function maintenanceConfigurationFingerprint(configuration) {
  const keys = [
    "repoPath",
    "stateDir",
    "cacheDir",
    "rtkPath",
    "codexPath",
    "repoSlug",
    "originUrl",
  ];
  return createHash("sha256")
    .update(JSON.stringify(keys.map((key) => [key, configuration[key]])))
    .digest("hex");
}

function appendLog(logPath, value) {
  writeFileSync(logPath, `${redactText(value).replaceAll("\0", "\\0")}\n`, {
    encoding: "utf8",
    flag: "a",
    mode: 0o600,
  });
}

function commandString(args) {
  return args
    .map((part) =>
      /^[A-Za-z0-9_./:=@+-]+$/.test(part) ? part : JSON.stringify(part),
    )
    .join(" ");
}

function outputTail(value, limit = maxCommandOutput) {
  const clean = redactText(value);
  return clean.length <= limit
    ? clean
    : `[truncated ${clean.length - limit} characters]\n${clean.slice(-limit)}`;
}

export function retainExactStdout(record, stdout) {
  Object.defineProperty(record, "fullStdout", {
    value: String(stdout ?? ""),
    enumerable: false,
  });
  return record;
}

function terminateManagedProcessTree(pid, signal) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    const result = spawnSync(
      "taskkill.exe",
      ["/pid", String(pid), "/t", "/f"],
      { stdio: "ignore", windowsHide: true },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (error?.code === "ESRCH") return;
        throw error;
      }
      throw new Error(`taskkill failed with exit code ${result.status}`);
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

export function runManagedSubprocess(argv) {
  const [timeoutValue, requestedExecutable, ...args] = argv;
  const timeoutMs = Number(timeoutValue);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw new Error("managed subprocess timeout is invalid");
  if (!requestedExecutable || args.length === 0)
    throw new Error("managed subprocess command is incomplete");
  const executable = resolveApprovedExecutable("rtk", requestedExecutable);
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, args, {
      detached: process.platform !== "win32",
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
    });
    let timedOut = false;
    let settled = false;
    let childExited = false;
    let childCode = 1;
    let terminationError = null;
    let timeoutHandle;
    let forceHandle;
    let pollHandle;
    const cleanup = () => {
      clearTimeout(timeoutHandle);
      clearTimeout(forceHandle);
      clearInterval(pollHandle);
      process.off("SIGINT", terminate);
      process.off("SIGTERM", terminate);
    };
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const processGroupExists = () => {
      if (process.platform === "win32") return false;
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (error) {
        if (error?.code === "ESRCH") return false;
        if (error?.code === "EPERM") return true;
        throw error;
      }
    };
    const finishWhenStopped = () => {
      if (!childExited) return;
      if (!timedOut) {
        settle(resolvePromise, childCode);
      } else if (!processGroupExists()) {
        if (terminationError) settle(rejectPromise, terminationError);
        else settle(resolvePromise, 124);
      }
    };
    const terminate = () => {
      if (timedOut) return;
      timedOut = true;
      try {
        terminateManagedProcessTree(child.pid, "SIGTERM");
      } catch (error) {
        terminationError = error;
        child.kill("SIGTERM");
        console.error(
          `managed process termination failed: ${safeError(error)}`,
        );
      }
      pollHandle = setInterval(finishWhenStopped, 50);
      forceHandle = setTimeout(() => {
        try {
          terminateManagedProcessTree(child.pid, "SIGKILL");
        } catch (error) {
          terminationError ??= error;
          child.kill("SIGKILL");
          console.error(`managed process kill failed: ${safeError(error)}`);
        }
        finishWhenStopped();
      }, managedSubprocessKillGraceMs);
      finishWhenStopped();
    };
    process.once("SIGINT", terminate);
    process.once("SIGTERM", terminate);
    child.once("error", (error) => {
      settle(rejectPromise, error);
    });
    child.once("exit", (code) => {
      childExited = true;
      childCode = Number.isInteger(code) ? code : 1;
      finishWhenStopped();
    });
    timeoutHandle = setTimeout(terminate, timeoutMs);
  });
}

function runRtk(configuration, args, options = {}) {
  const started = Date.now();
  const command = commandString([configuration.rtkPath, ...args]);
  appendLog(options.logPath, `$ ${command}`);
  const timeoutMs = options.timeoutMs ?? defaultCommandTimeoutMs;
  const environment = sanitizedEnvironment(options.env, {
    allowCredentials: options.allowCredentials,
  });
  for (const [key, value] of Object.entries(options.trustedEnvironment ?? {})) {
    if (key !== "GIT_INDEX_FILE" || typeof value !== "string") {
      throw new Error(`unsupported trusted environment override: ${key}`);
    }
    environment[key] = value;
  }
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(import.meta.url),
      managedSubprocessMarker,
      String(timeoutMs),
      configuration.rtkPath,
      ...args,
    ],
    {
      cwd: options.cwd ?? configuration.repoPath,
      encoding: "utf8",
      env: environment,
      maxBuffer: 16 * 1024 * 1024,
      timeout: timeoutMs + managedSubprocessGraceMs,
      killSignal: "SIGKILL",
    },
  );
  const stdout = outputTail(result.stdout);
  const stderr = outputTail(result.stderr);
  if (options.logOutput !== false) {
    if (stdout) appendLog(options.logPath, stdout);
    if (stderr) appendLog(options.logPath, stderr);
  }
  const timedOut = Boolean(
    result.status === 124 ||
    (result.error && result.error.code === "ETIMEDOUT"),
  );
  const code = Number.isInteger(result.status)
    ? result.status
    : timedOut
      ? 124
      : 1;
  const record = {
    command: commandString(args),
    code,
    durationMs: Date.now() - started,
    timedOut,
    stdout,
    stderr,
  };
  retainExactStdout(record, result.stdout);
  if (options.check && code !== 0) {
    const error = new Error(`${record.command} failed with exit code ${code}`);
    error.commandRecord = record;
    throw error;
  }
  return record;
}

function git(configuration, workspace, args, options = {}) {
  const trustedEnvironment = options.indexPath
    ? { GIT_INDEX_FILE: resolve(options.indexPath) }
    : undefined;
  const { indexPath: _indexPath, ...runOptions } = options;
  return runRtk(
    configuration,
    [
      "proxy",
      "git",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      ...args,
    ],
    {
      cwd: workspace,
      ...runOptions,
      trustedEnvironment,
    },
  );
}

function stdoutLine(record, description) {
  const value = record.fullStdout.trim();
  if (!value || value.includes("\n"))
    throw new Error(`could not resolve ${description}`);
  return value;
}

function exactStdout(record) {
  return record.fullStdout;
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

function readState(path) {
  if (!existsSync(path)) return { schemaVersion: maintenanceSchemaVersion };
  const state = readJson(path);
  if (state.schemaVersion !== maintenanceSchemaVersion)
    throw new Error("unsupported maintenance state schema");
  return state;
}

function rotateReports(reportDir, keep = 30) {
  const files = readdirSync(reportDir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() && /^(?:report|run)-.*\.(?:json|log)$/.test(entry.name),
    )
    .map((entry) => ({
      name: entry.name,
      path: join(reportDir, entry.name),
      mtime: statSync(join(reportDir, entry.name)).mtimeMs,
    }))
    .sort((left, right) => right.mtime - left.mtime);
  const runIds = [];
  for (const file of files) {
    const id = file.name
      .replace(/^(?:report|run)-/, "")
      .replace(/\.(?:json|log)$/, "");
    if (!runIds.includes(id)) runIds.push(id);
  }
  for (const id of runIds.slice(keep)) {
    for (const prefix of ["report", "run"]) {
      rmSync(
        join(
          reportDir,
          `${prefix}-${id}.${prefix === "report" ? "json" : "log"}`,
        ),
        { force: true },
      );
    }
  }
}

export function maintenanceRunCacheRoot(stateDir) {
  const namespace = createHash("sha256")
    .update(resolve(stateDir))
    .digest("hex")
    .slice(0, 24);
  return join(tmpdir(), "Y2SyncMaintenanceRuns", namespace);
}

export function scavengeAbandonedRunRoots(runCacheRoot) {
  if (!existsSync(runCacheRoot)) return [];
  const removed = [];
  for (const entry of readdirSync(runCacheRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^run-[A-Za-z0-9_-]+$/.test(entry.name))
      continue;
    const path = join(runCacheRoot, entry.name);
    safeRemoveRunRoot(path, runCacheRoot);
    removed.push(path);
  }
  return removed.sort();
}

export function finalizeInterruptedReports(reportDir, completedAt = nowIso()) {
  if (!existsSync(reportDir)) return [];
  const finalized = [];
  for (const entry of readdirSync(reportDir, { withFileTypes: true })) {
    if (!entry.isFile() || !/^report-[A-Za-z0-9_-]+\.json$/.test(entry.name))
      continue;
    const path = join(reportDir, entry.name);
    let report;
    try {
      report = readJson(path);
    } catch {
      continue;
    }
    if (
      report?.schemaVersion !== maintenanceSchemaVersion ||
      report?.outcome !== "running"
    )
      continue;
    writeJsonAtomic(path, {
      ...report,
      completedAt,
      outcome: "interrupted",
      error: "maintenance process ended before completion",
    });
    finalized.push(path);
  }
  return finalized.sort();
}

export function removeAbandonedReportTemps(reportDir) {
  if (!existsSync(reportDir)) return [];
  const removed = [];
  for (const entry of readdirSync(reportDir, { withFileTypes: true })) {
    if (
      !entry.isFile() ||
      !/^report-[A-Za-z0-9_-]+\.json\.tmp-\d+$/.test(entry.name)
    )
      continue;
    const path = join(reportDir, entry.name);
    rmSync(path, { force: true });
    removed.push(path);
  }
  return removed.sort();
}

export function discoverNodeTests(workspace) {
  const roots = [
    join(workspace, "hifimule-ui", "tests"),
    join(workspace, "scripts", "tests"),
  ];
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith(".test.mjs")) {
        files.push(relative(workspace, path));
      }
    }
  };
  for (const root of roots) {
    if (existsSync(root)) visit(root);
  }
  return files.sort();
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function canonicalExistingPath(path) {
  const resolved = resolve(path);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function isolateHomeDirectory(filesystem, allowed) {
  const logicalHome = resolve(homedir());
  const canonicalHome = canonicalExistingPath(logicalHome);
  filesystem.set(logicalHome, "deny");
  filesystem.set(canonicalHome, "deny");
  for (const [path, access] of allowed) {
    const resolved = resolve(path);
    const canonical = canonicalExistingPath(resolved);
    if (canonical !== resolved) {
      filesystem.set(resolved, access);
    }
    filesystem.set(canonical, access);
  }
}

function restrictTemporaryDirectoryWrites(filesystem) {
  const roots = new Set([
    resolve(tmpdir()),
    canonicalExistingPath(tmpdir()),
    ...(process.platform === "darwin"
      ? [resolve("/tmp"), canonicalExistingPath("/tmp")]
      : []),
  ]);
  for (const root of roots) filesystem.set(root, "read");
}

function grantExecutableTraversal(filesystem, paths) {
  const home = canonicalExistingPath(homedir());
  const byDirectory = new Map();
  for (const path of paths.filter(Boolean)) {
    const logical = resolve(path);
    const canonical = canonicalExistingPath(logical);
    for (const executable of new Set([logical, canonical])) {
      if (!executable.startsWith(`${home}${sep}`)) continue;
      const directory = dirname(executable);
      if (!byDirectory.has(directory)) byDirectory.set(directory, new Set());
      byDirectory.get(directory).add(basename(executable));
    }
  }
  for (const [directory, approvedNames] of byDirectory) {
    const directoryAlreadyAllowed = ["read", "write"].includes(
      filesystem.get(directory),
    );
    filesystem.set(directory, "read");
    if (directoryAlreadyAllowed) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      filesystem.set(
        join(directory, entry.name),
        approvedNames.has(entry.name) ? "read" : "deny",
      );
    }
  }
}

export function sandboxPermissionOverride({
  profileName,
  workspace,
  scratchDir,
  rtkPath,
  codexPath = null,
  toolCacheDir = null,
  toolCacheAccess = "read",
  writableCargoLocks = false,
  workspaceAccess = "write",
  network = false,
  allowLocalBinding = false,
}) {
  if (!/^[A-Za-z0-9_-]+$/.test(profileName))
    throw new Error("sandbox profile name is invalid");
  if (
    !["read", "write"].includes(workspaceAccess) ||
    !["read", "write"].includes(toolCacheAccess)
  ) {
    throw new Error("sandbox filesystem access is invalid");
  }
  const allowed = new Map([
    [resolve(workspace), workspaceAccess],
    [resolve(workspace, ".git"), "read"],
    [resolve(scratchDir), "write"],
    [resolve(rtkPath), "read"],
    [resolve(process.execPath), "read"],
  ]);
  if (codexPath) allowed.set(resolve(codexPath), "read");
  if (toolCacheDir) allowed.set(resolve(toolCacheDir), toolCacheAccess);
  if (toolCacheDir && writableCargoLocks) {
    for (const name of [".package-cache", ".package-cache-mutate"]) {
      allowed.set(resolve(toolCacheDir, "cargo", name), "write");
    }
  }
  for (const path of [
    join(homedir(), ".cargo", "bin"),
    join(homedir(), ".rustup"),
  ]) {
    if (existsSync(path)) allowed.set(resolve(path), "read");
  }
  const filesystem = new Map();
  restrictTemporaryDirectoryWrites(filesystem);
  isolateHomeDirectory(filesystem, allowed);
  grantExecutableTraversal(filesystem, [rtkPath, codexPath]);
  const entries = [...filesystem]
    .map(([path, access]) => `${tomlString(path)}=${tomlString(access)}`)
    .join(",");
  const networkEnabled = network || allowLocalBinding;
  const localBinding = allowLocalBinding ? ",allow_local_binding=true" : "";
  const baseProfile = ":read-only";
  return `permissions.${profileName}={extends=${tomlString(baseProfile)},filesystem={${entries}},network={enabled=${networkEnabled ? "true" : "false"}${localBinding}}}`;
}

export function gateEnvironment(configuration) {
  const scratchDir = mkdtempSync(join(tmpdir(), "y2m-"));
  const toolCacheDir = join(configuration.cacheDir, "tooling");
  const home = join(scratchDir, "home");
  const temporary = join(scratchDir, "tmp");
  const xdgCache = join(scratchDir, "xdg-cache");
  const codexHome = join(scratchDir, "codex-home");
  const cargoHome = join(toolCacheDir, "cargo");
  const npmCache = join(toolCacheDir, "npm");
  const npmGlobalConfig = join(scratchDir, "npm-globalrc");
  const npmUserConfig = join(scratchDir, "npmrc");
  for (const path of [
    home,
    temporary,
    xdgCache,
    codexHome,
    cargoHome,
    npmCache,
  ]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  for (const path of [npmGlobalConfig, npmUserConfig]) {
    writeFileSync(path, "", { mode: 0o600 });
  }
  const environment = {
    ...process.env,
    HOME: home,
    TMPDIR: `${temporary}${sep}`,
    TMP: temporary,
    TEMP: temporary,
    XDG_CACHE_HOME: xdgCache,
    CODEX_HOME: codexHome,
    CARGO_HOME: cargoHome,
    npm_config_cache: npmCache,
    npm_config_globalconfig: npmGlobalConfig,
    npm_config_userconfig: npmUserConfig,
    CI: "1",
  };
  const rustupHome = process.env.RUSTUP_HOME ?? join(homedir(), ".rustup");
  if (existsSync(rustupHome)) environment.RUSTUP_HOME = rustupHome;
  return {
    environment,
    scratchDir,
    toolCacheDir,
    cleanup: () => rmSync(scratchDir, { recursive: true, force: true }),
  };
}

export function maintenanceGatePlan(workspace) {
  const workspaceRoot = canonicalExistingPath(workspace);
  const nodeTests = discoverNodeTests(workspaceRoot);
  if (!nodeTests.length) throw new Error("no Node regression tests were found");
  const audioSource = validatedAudioRuntimeSource(workspaceRoot);
  return [
    { id: "diff-check", args: ["proxy", "git", "diff", "--check", "HEAD"] },
    { id: "rustfmt", args: ["cargo", "fmt", "--all", "--", "--check"] },
    {
      id: "ui-install",
      args: [
        "npm",
        "ci",
        "--prefix",
        join(workspaceRoot, "hifimule-ui"),
        "--ignore-scripts",
        "--workspaces=false",
      ],
      network: true,
      cacheWrite: true,
      isolatedCwd: true,
    },
    {
      id: "cargo-fetch",
      args: [
        "cargo",
        "fetch",
        "--locked",
        "--manifest-path",
        join(workspaceRoot, "Cargo.toml"),
      ],
      network: true,
      cacheWrite: true,
      isolatedCwd: true,
    },
    {
      id: "audio-source-fetch",
      args: [
        "proxy",
        "curl",
        "--disable",
        "--fail",
        "--location",
        "--retry",
        "3",
        "--connect-timeout",
        "30",
        "--max-time",
        "300",
        "--max-filesize",
        String(100 * 1024 * 1024),
        "--proto",
        "=https",
        "--proto-redir",
        "=https",
        "--create-dirs",
        "--output",
        audioSource.archivePath,
        audioSource.sourceUrl,
      ],
      network: true,
      isolatedCwd: true,
    },
    {
      id: "audio-source-verify",
      args: [
        "proxy",
        "node",
        "-e",
        verifySha256Program,
        audioSource.archivePath,
        audioSource.sourceSha256,
      ],
    },
    {
      id: "npm-audit",
      args: [
        "npm",
        "audit",
        "--prefix",
        join(workspaceRoot, "hifimule-ui"),
        "--omit=dev",
      ],
      network: true,
      cacheWrite: true,
      isolatedCwd: true,
    },
    { id: "node-tests", args: ["proxy", "node", "--test", ...nodeTests] },
    {
      id: "python-tests",
      args: [
        "proxy",
        "python3",
        "-m",
        "unittest",
        "discover",
        "-s",
        "scripts/tests",
        "-p",
        "test_*.py",
      ],
    },
    {
      id: "ui-build",
      args: ["npm", "run", "build", "--prefix", "hifimule-ui"],
    },
    {
      id: "audio-fixtures",
      args: [
        "proxy",
        "python3",
        "experiments/playback-probe/generate-fixtures.py",
      ],
    },
    {
      id: "daemon-check",
      args: [
        "npm",
        "run",
        "build:daemon",
        "--",
        "check",
        "-p",
        "hifimule-daemon",
      ],
      cargoOffline: true,
      timeoutMs: longBuildTimeoutMs,
    },
    {
      id: "local-network-probe",
      args: ["proxy", "node", "-e", localNetworkProbeProgram],
      localNetwork: true,
    },
    {
      id: "daemon-tests",
      args: [
        "npm",
        "run",
        "build:daemon",
        "--",
        "test",
        "-p",
        "hifimule-daemon",
      ],
      cargoOffline: true,
      localNetwork: true,
      timeoutMs: longBuildTimeoutMs,
    },
    {
      id: "support-tests",
      args: [
        "npm",
        "run",
        "build:daemon",
        "--",
        "test",
        "-p",
        "hifimule-i18n",
        "-p",
        "hifimule-lifecycle",
      ],
      cargoOffline: true,
      localNetwork: true,
      timeoutMs: longBuildTimeoutMs,
    },
  ];
}

function runGates(configuration, workspace, logPath, options = {}) {
  const results = [];
  for (const gate of maintenanceGatePlan(workspace)) {
    const { environment, scratchDir, toolCacheDir, cleanup } =
      gateEnvironment(configuration);
    try {
      const commandCwd = gate.isolatedCwd ? scratchDir : workspace;
      const networkMode = gate.localNetwork
        ? "local"
        : gate.network
          ? "network"
          : "offline";
      const profileName = `y2-gate-${networkMode}-${gate.cacheWrite ? "write" : "read"}`;
      const profile = sandboxPermissionOverride({
        profileName,
        workspace,
        scratchDir,
        rtkPath: configuration.rtkPath,
        toolCacheDir,
        toolCacheAccess: gate.cacheWrite ? "write" : "read",
        writableCargoLocks: Boolean(gate.cargoOffline),
        network: Boolean(gate.network),
        allowLocalBinding: Boolean(gate.localNetwork),
      });
      const result = runRtk(
        configuration,
        [
          "proxy",
          configuration.codexPath,
          "sandbox",
          ...(gate.localNetwork ? ["--enable", "network_proxy"] : []),
          "-P",
          profileName,
          "-c",
          profile,
          "-C",
          commandCwd,
          "--",
          configuration.rtkPath,
          ...gate.args,
        ],
        {
          cwd: commandCwd,
          env: gate.cargoOffline
            ? { ...environment, CARGO_NET_OFFLINE: "true" }
            : environment,
          logPath,
          timeoutMs: gate.timeoutMs,
        },
      );
      results.push({ id: gate.id, ...result });
      if (result.code !== 0) break;
    } finally {
      cleanup();
    }
  }
  if (options.requireCleanTree) {
    const integrity = git(
      configuration,
      workspace,
      ["status", "--porcelain=v1", "--untracked-files=all"],
      { logPath, check: true },
    );
    integrity.code = integrity.fullStdout.trim() ? 1 : 0;
    results.push({ id: "tracked-tree-integrity", ...integrity });
  }
  return results;
}

function gatesPassed(results) {
  return results.length > 0 && results.every((result) => result.code === 0);
}

export function isAllowedAutomatedFixPath(path) {
  const normalized = String(path).replaceAll("\\", "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.includes("../") ||
    /[\x00-\x1f\x7f:]/.test(normalized)
  )
    return false;
  if (protectedFixPaths.has(normalized)) return false;
  return (
    allowedFixFiles.has(normalized) ||
    allowedFixPrefixes.some((prefix) => normalized.startsWith(prefix))
  );
}

function parseNulList(value) {
  return value.split("\0").filter(Boolean);
}

function parseNameStatus(value) {
  const fields = parseNulList(value);
  const records = [];
  for (let index = 0; index < fields.length; ) {
    const status = fields[index++];
    const path = fields[index++];
    if (!status || !path)
      throw new Error("Git returned a malformed name-status record");
    if (/^[RC]/.test(status)) {
      const destination = fields[index++];
      if (!destination)
        throw new Error("Git returned a malformed rename/copy record");
      records.push({ status, path, destination });
    } else records.push({ status, path });
  }
  return records;
}

function isTestPath(path) {
  const normalized = String(path).replaceAll("\\", "/");
  const name = normalized.split("/").at(-1) ?? "";
  return (
    allowedTestPrefixes.some((prefix) => normalized.startsWith(prefix)) ||
    /(?:^|[._-])tests?\.(?:rs|py|[cm]?[jt]sx?)$/i.test(name)
  );
}

export function isRunnableAddedTestPath(path) {
  const normalized = String(path).replaceAll("\\", "/");
  for (const prefix of allowedTestPrefixes) {
    if (!normalized.startsWith(prefix)) continue;
    const relativePath = normalized.slice(prefix.length);
    if (relativePath.endsWith(".test.mjs")) return true;
    if (
      prefix === "scripts/tests/" &&
      !relativePath.includes("/") &&
      /^test_.+\.py$/.test(relativePath)
    ) {
      return true;
    }
  }
  return false;
}

export function rustSourceContainsTests(path, source) {
  const normalized = String(path).replaceAll("\\", "/");
  if (isTestPath(normalized)) return true;
  const value = String(source);
  return (
    /#\s*\[\s*(?:(?:[A-Za-z_][A-Za-z0-9_]*)\s*::\s*)*(?:test|rstest|test_case)\b/.test(
      value,
    ) ||
    /#\s*\[\s*cfg(?:_attr)?\s*\([\s\S]{0,500}?\btest\b/.test(value) ||
    /(?:^|\n)\s*(?:pub\s+)?mod\s+(?:tests?|[A-Za-z0-9_]*_tests?)\s*;/.test(
      value,
    )
  );
}

export function addedPatchContainsSecret(patch) {
  const added = String(patch)
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
  return [
    /-----BEGIN (?:(?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----/i,
    /\b(?:gh[opsu]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,})\b/,
    /\b(?:sk-[A-Za-z0-9_-]{20,}|sk_live_[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{30,})\b/,
    /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
    /\b(?:npm_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/,
    /(?:authorization\s*[:=]\s*(?:bearer\s+)?|aws_secret_access_key\s*[:=]|_authToken\s*=)\s*["']?[A-Za-z0-9_./+=-]{20,}/i,
  ].some((pattern) => pattern.test(added));
}

export function validateAutomatedDiff({
  records,
  summaries,
  patch,
  fileMetadata,
}) {
  if (!records.length)
    throw new Error("automated remediation produced no changes");
  if (records.length > 100)
    throw new Error("automated remediation changed too many files");
  if (Buffer.byteLength(patch) > 2 * 1024 * 1024)
    throw new Error("automated patch exceeds 2 MiB");
  if (/GIT binary patch|Binary files .* differ/.test(patch))
    throw new Error("automated patch contains binary content");
  if (addedPatchContainsSecret(patch)) {
    throw new Error("automated patch contains a secret-like value");
  }
  if (/mode change|delete mode|rename |copy |120000|160000/.test(summaries)) {
    throw new Error(
      "automated patch changes file identity, mode, symlinks, submodules, or deletes files",
    );
  }
  for (const record of records) {
    if (!/^[AM]$/.test(record.status))
      throw new Error(
        `automated patch uses rejected Git status ${record.status}`,
      );
    if (!isAllowedAutomatedFixPath(record.path))
      throw new Error(`automated patch touches protected path ${record.path}`);
    const metadata = fileMetadata[record.path];
    if (
      !metadata ||
      !metadata.regular ||
      metadata.symlink ||
      metadata.size > 512 * 1024
    ) {
      throw new Error(
        `automated patch contains an unsafe or oversized file: ${record.path}`,
      );
    }
    if (isTestPath(record.path) && record.status !== "A") {
      throw new Error(
        `automated remediation may add tests but cannot modify an existing test: ${record.path}`,
      );
    }
    if (isTestPath(record.path) && !isRunnableAddedTestPath(record.path)) {
      throw new Error(
        `added regression test is not executed by a fixed gate: ${record.path}`,
      );
    }
    if (
      record.status === "M" &&
      record.path.endsWith(".rs") &&
      metadata.baselineHasInlineTests
    ) {
      throw new Error(
        `automated remediation cannot modify Rust source containing existing inline tests: ${record.path}`,
      );
    }
  }
  return records.map((record) => record.path);
}

export function parsePatchNumstat(value) {
  return parseNulList(value).map((record) => {
    const match = record.match(/^(\d+)\t(\d+)\t(.+)$/s);
    if (!match)
      throw new Error("Git returned malformed or binary patch statistics");
    return match[3];
  });
}

export function assertExactPatchPaths(expectedPaths, patchPaths) {
  const expected = [...new Set(expectedPaths)].sort();
  const actual = [...new Set(patchPaths)].sort();
  if (
    expected.length !== expectedPaths.length ||
    actual.length !== patchPaths.length ||
    expected.length !== actual.length ||
    expected.some((path, index) => path !== actual[index])
  ) {
    throw new Error("exact patch paths do not match the validated change set");
  }
}

export function prepareValidatedPatch(
  configuration,
  workspace,
  runRoot,
  logPath,
) {
  const safeDiff = ["--no-ext-diff", "--no-textconv", "--no-renames"];
  const trackedRecords = parseNameStatus(
    git(
      configuration,
      workspace,
      ["diff", ...safeDiff, "--name-status", "-z", "HEAD"],
      { logPath, check: true },
    ).fullStdout,
  );
  const untracked = parseNulList(
    git(
      configuration,
      workspace,
      ["ls-files", "--others", "--exclude-standard", "-z"],
      { logPath, check: true },
    ).fullStdout,
  );
  const preliminaryRecords = [
    ...trackedRecords,
    ...untracked.map((path) => ({ status: "A", path })),
  ];
  if (!preliminaryRecords.length)
    throw new Error("automated remediation produced no changes");
  if (preliminaryRecords.length > 100)
    throw new Error("automated remediation changed too many files");
  for (const record of preliminaryRecords) {
    if (!/^[AM]$/.test(record.status))
      throw new Error(
        `automated patch uses rejected Git status ${record.status}`,
      );
    if (!isAllowedAutomatedFixPath(record.path))
      throw new Error(`automated patch touches protected path ${record.path}`);
    const metadata = lstatSync(resolve(workspace, record.path));
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size > 512 * 1024
    ) {
      throw new Error(
        `automated patch contains an unsafe or oversized file: ${record.path}`,
      );
    }
  }
  const candidatePaths = preliminaryRecords.map((record) => record.path);
  if (new Set(candidatePaths).size !== candidatePaths.length)
    throw new Error("automated remediation returned duplicate changed paths");

  const indexPath = join(runRoot, "remediation.index");
  rmSync(indexPath, { force: true });
  git(configuration, workspace, ["read-tree", "HEAD"], {
    logPath,
    check: true,
    indexPath,
  });
  git(configuration, workspace, ["add", "-A", "--", ...candidatePaths], {
    logPath,
    check: true,
    indexPath,
  });
  const records = parseNameStatus(
    git(
      configuration,
      workspace,
      ["diff", "--cached", ...safeDiff, "--name-status", "-z", "HEAD"],
      { logPath, check: true, indexPath },
    ).fullStdout,
  );
  assertExactPatchPaths(
    candidatePaths,
    records.map((record) => record.path),
  );
  const summaries = exactStdout(
    git(
      configuration,
      workspace,
      ["diff", "--cached", ...safeDiff, "--summary", "HEAD"],
      { logPath, check: true, indexPath },
    ),
  );
  const patch = git(
    configuration,
    workspace,
    [
      "diff",
      "--cached",
      ...safeDiff,
      "--binary",
      "--full-index",
      "HEAD",
      "--",
      ...candidatePaths,
    ],
    { logPath, check: true, indexPath },
  ).fullStdout;
  const fileMetadata = {};
  for (const record of records) {
    const path = resolve(workspace, record.path);
    if (!path.startsWith(`${resolve(workspace)}${sep}`))
      throw new Error(`unsafe changed path: ${record.path}`);
    const metadata = lstatSync(path);
    let baselineHasInlineTests = false;
    if (record.status === "M" && record.path.endsWith(".rs")) {
      const baseline = git(
        configuration,
        workspace,
        ["show", `HEAD:${record.path}`],
        { logPath, check: true },
      ).fullStdout;
      baselineHasInlineTests = rustSourceContainsTests(record.path, baseline);
    }
    fileMetadata[record.path] = {
      regular: metadata.isFile(),
      symlink: metadata.isSymbolicLink(),
      size: metadata.size,
      baselineHasInlineTests,
    };
  }
  const paths = validateAutomatedDiff({
    records,
    summaries,
    patch,
    fileMetadata,
  });
  const patchPath = join(runRoot, "remediation.patch");
  writeFileSync(patchPath, patch, { encoding: "utf8", mode: 0o600 });
  const patchPaths = parsePatchNumstat(
    git(configuration, workspace, ["apply", "--numstat", "-z", patchPath], {
      logPath,
      check: true,
    }).fullStdout,
  );
  assertExactPatchPaths(paths, patchPaths);
  return { patch, patchPath, paths };
}

export function assertExactValidatedPatch({
  expectedPatch,
  stagedPatch,
  unstagedPatch,
  untracked,
}) {
  if (
    stagedPatch !== expectedPatch ||
    unstagedPatch !== "" ||
    untracked.length
  ) {
    throw new Error(
      "post-gate tree no longer matches the exact validated patch",
    );
  }
}

function verifyExactValidatedPatch(
  configuration,
  workspace,
  prepared,
  logPath,
) {
  const stagedPatch = git(
    configuration,
    workspace,
    [
      "diff",
      "--cached",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--binary",
      "--full-index",
      "HEAD",
    ],
    { logPath, check: true },
  ).fullStdout;
  const unstagedPatch = git(
    configuration,
    workspace,
    [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--binary",
      "--full-index",
    ],
    { logPath, check: true },
  ).fullStdout;
  const untracked = parseNulList(
    git(
      configuration,
      workspace,
      ["ls-files", "--others", "--exclude-standard", "-z"],
      { logPath, check: true },
    ).fullStdout,
  );
  assertExactValidatedPatch({
    expectedPatch: prepared.patch,
    stagedPatch,
    unstagedPatch,
    untracked,
  });
}

function validateReview(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Codex review did not return an object");
  if (
    typeof value.summary !== "string" ||
    value.summary.length > 2000 ||
    !Array.isArray(value.findings) ||
    value.findings.length > 10
  ) {
    throw new Error("Codex review did not match the bounded review contract");
  }
  const severities = new Set(["critical", "high", "medium", "low"]);
  for (const finding of value.findings) {
    if (
      !finding ||
      typeof finding !== "object" ||
      !severities.has(finding.severity)
    )
      throw new Error("Codex review has an invalid severity");
    for (const field of ["title", "file", "evidence", "recommendedFix"]) {
      if (typeof finding[field] !== "string")
        throw new Error(`Codex review has an invalid ${field}`);
    }
    if (
      finding.line !== null &&
      (!Number.isSafeInteger(finding.line) || finding.line < 1)
    )
      throw new Error("Codex review has an invalid line");
  }
  return value;
}

function codexBaseArgs(configuration, workspace, scratchDir, workspaceAccess) {
  mkdirSync(scratchDir, { recursive: true, mode: 0o700 });
  const profileName = `y2-model-${workspaceAccess}`;
  const profile = sandboxPermissionOverride({
    profileName,
    workspace,
    scratchDir,
    rtkPath: configuration.rtkPath,
    codexPath: configuration.codexPath,
    workspaceAccess,
    network: false,
  });
  return [
    "proxy",
    configuration.codexPath,
    "--no-daemon",
    "-a",
    "never",
    "-c",
    `default_permissions=${tomlString(profileName)}`,
    "-c",
    profile,
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "-C",
    workspace,
    "--color",
    "never",
  ];
}

export function modelEnvironment(scratchDir) {
  const root = resolve(scratchDir);
  const home = join(root, "home");
  const temporary = join(root, "tmp");
  const xdgCache = join(root, "xdg-cache");
  const cargoHome = join(root, "cargo");
  const npmCache = join(root, "npm");
  for (const path of [home, temporary, xdgCache, cargoHome, npmCache]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  return {
    ...process.env,
    HOME: home,
    TMPDIR: `${temporary}${sep}`,
    TMP: temporary,
    TEMP: temporary,
    XDG_CACHE_HOME: xdgCache,
    CARGO_HOME: cargoHome,
    npm_config_cache: npmCache,
    CODEX_HOME: process.env.CODEX_HOME ?? join(homedir(), ".codex"),
    CI: "1",
  };
}

function runCodexReview(
  configuration,
  workspace,
  range,
  changed,
  runRoot,
  logPath,
) {
  const outputPath = join(runRoot, "review.json");
  const scratchDir = join(runRoot, "review-sandbox");
  const prompt = [
    "Perform a read-only production review of the changed code in this repository.",
    `Review range: ${range}.`,
    `Changed paths: ${changed.length ? changed.join(", ") : "none resolved"}.`,
    "Focus on concrete correctness, security, data-loss, accessibility, and cross-platform defects.",
    "Do not report style preferences or speculative issues without file-and-line evidence.",
    "Do not edit files. Return only the requested bounded JSON result.",
  ].join("\n");
  const result = runRtk(
    configuration,
    [
      ...codexBaseArgs(configuration, workspace, scratchDir, "read"),
      "--output-schema",
      reviewSchemaPath,
      "--output-last-message",
      outputPath,
      prompt,
    ],
    {
      cwd: workspace,
      logPath,
      timeoutMs: codexTimeoutMs,
      env: modelEnvironment(scratchDir),
    },
  );
  if (result.code !== 0)
    throw new Error(`Codex review failed with exit code ${result.code}`);
  if (
    !existsSync(outputPath) ||
    statSync(outputPath).size <= 0 ||
    statSync(outputPath).size > maxReviewBytes
  ) {
    throw new Error("Codex review output is missing, empty, or oversized");
  }
  return validateReview(readJson(outputPath));
}

export function shouldAttemptRemediation(gates, review) {
  if (!gatesPassed(gates)) return true;
  return review.findings.some((finding) =>
    ["critical", "high", "medium"].includes(finding.severity),
  );
}

function runCodexFix(
  configuration,
  workspace,
  gates,
  review,
  runRoot,
  logPath,
) {
  const outputPath = join(runRoot, "fix-summary.txt");
  const scratchDir = join(runRoot, "fix-sandbox");
  const failing = gates
    .filter((gate) => gate.code !== 0)
    .map((gate) => ({
      id: gate.id,
      code: gate.code,
      stderr: gate.stderr.slice(-4000),
      stdout: gate.stdout.slice(-4000),
    }));
  const prompt = [
    "Repair the concrete maintenance failures and reviewed medium-or-higher defects in this disposable repository clone.",
    `Gate failures: ${JSON.stringify(failing)}.`,
    `Review: ${JSON.stringify(review)}.`,
    `You may modify existing source or documentation only under these prefixes: ${allowedSourceFixPrefixes.join(", ")}.`,
    `You may also modify these exact files: ${[...allowedFixFiles].join(", ")}.`,
    `You may add new regression tests under these prefixes, but must not modify existing tests: ${allowedTestPrefixes.join(", ")}. Added tests must be *.test.mjs at any depth, or a top-level scripts/tests/test_*.py file.`,
    "Do not change workflows, manifests, lockfiles, capabilities, release/signing code, AGENTS.md, or maintenance automation.",
    "Do not weaken or delete tests. Add focused regression coverage when practical.",
    "Use rtk-prefixed commands. Do not commit, push, open a PR, access secrets, or modify anything outside this clone.",
    "Finish with a concise plain-text summary; deterministic gates will be rerun independently.",
  ].join("\n");
  return runRtk(
    configuration,
    [
      ...codexBaseArgs(configuration, workspace, scratchDir, "write"),
      "--output-last-message",
      outputPath,
      prompt,
    ],
    {
      cwd: workspace,
      logPath,
      timeoutMs: codexTimeoutMs,
      env: modelEnvironment(scratchDir),
    },
  );
}

function branchSafeTimestamp(date = new Date()) {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z")
    .toLowerCase();
}

export function maintenanceBranchName(targetSha, date = new Date()) {
  if (!/^[a-f0-9]{40}$/i.test(targetSha))
    throw new Error("target SHA must be a full commit ID");
  return `automation/maintenance-${branchSafeTimestamp(date)}-${targetSha.slice(0, 8).toLowerCase()}`;
}

function buildPullRequestBody(report) {
  const failed = report.initialGates
    .filter((gate) => gate.code !== 0)
    .map((gate) => `- ${gate.id}: exit ${gate.code}`);
  const findings = report.review.findings
    .filter((finding) =>
      ["critical", "high", "medium"].includes(finding.severity),
    )
    .map(
      (finding) =>
        `- **${finding.severity}** ${finding.title} — \`${finding.file}${finding.line ? `:${finding.line}` : ""}\``,
    );
  return [
    "## Automated maintenance finding",
    "",
    `Base revision: \`${report.targetSha}\``,
    "",
    "### Trigger",
    "",
    ...(failed.length
      ? failed
      : [
          "- Deterministic gates passed; Codex review found actionable defects.",
        ]),
    ...findings,
    "",
    "### Safety boundary",
    "",
    "- Created in a disposable clone; the operator worktree was not modified.",
    "- Fixed paths were allowlisted and all deterministic gates passed after the change.",
    "- This PR is intentionally not auto-merged and requires human review.",
  ].join("\n");
}

function createPullRequest(
  configuration,
  workspace,
  baseBranch,
  targetSha,
  report,
  runRoot,
  logPath,
) {
  const branch = maintenanceBranchName(targetSha);
  git(
    configuration,
    workspace,
    ["config", "user.name", "Y2 Sync Maintenance"],
    { logPath, check: true },
  );
  git(
    configuration,
    workspace,
    ["config", "user.email", "maintenance@users.noreply.github.com"],
    { logPath, check: true },
  );
  git(configuration, workspace, ["config", "commit.gpgsign", "false"], {
    logPath,
    check: true,
  });
  git(configuration, workspace, ["switch", "-c", branch], {
    logPath,
    check: true,
  });
  git(configuration, workspace, ["diff", "--cached", "--check"], {
    logPath,
    check: true,
  });
  git(
    configuration,
    workspace,
    ["commit", "-m", `fix: automated maintenance for ${targetSha.slice(0, 8)}`],
    { logPath, check: true },
  );
  git(configuration, workspace, ["push", "--set-upstream", "origin", branch], {
    logPath,
    check: true,
    allowCredentials: true,
  });
  const bodyPath = join(runRoot, "pull-request.md");
  writeFileSync(bodyPath, `${buildPullRequestBody(report)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  const created = runRtk(
    configuration,
    [
      "gh",
      "pr",
      "create",
      "--draft",
      "--repo",
      configuration.repoSlug,
      "--base",
      baseBranch,
      "--head",
      branch,
      "--title",
      `Automated maintenance for ${targetSha.slice(0, 8)}`,
      "--body-file",
      bodyPath,
    ],
    { cwd: workspace, logPath, check: true, allowCredentials: true },
  );
  const url = created.fullStdout
    .split(/\s+/)
    .find((value) =>
      /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(value),
    );
  if (!url)
    throw new Error("GitHub did not return the created pull request URL");
  return { branch, url };
}

function clonePinnedWorkspace(
  configuration,
  source,
  destination,
  targetSha,
  logPath,
) {
  git(
    configuration,
    source,
    [
      "clone",
      "--local",
      "--no-hardlinks",
      "--no-checkout",
      source,
      destination,
    ],
    { logPath, check: true },
  );
  git(
    configuration,
    destination,
    ["remote", "set-url", "origin", configuration.originUrl],
    { logPath, check: true },
  );
  git(configuration, destination, ["checkout", "--detach", targetSha], {
    logPath,
    check: true,
  });
}

export function maintenanceWorkspacePlan(runRoot) {
  return {
    initialGates: join(runRoot, "initial-gates"),
    remediation: join(runRoot, "repo"),
    validation: join(runRoot, "validation"),
  };
}

function safeRemoveRunRoot(runRoot, runCacheRoot) {
  const resolvedRunRoot = resolve(runRoot);
  const resolvedCacheRoot = resolve(runCacheRoot);
  if (
    !basename(resolvedRunRoot).startsWith("run-") ||
    !resolvedRunRoot.startsWith(`${resolvedCacheRoot}${sep}`)
  ) {
    throw new Error(
      "refusing to remove an untrusted maintenance run directory",
    );
  }
  rmSync(resolvedRunRoot, { recursive: true, force: true });
}

export function rangeForReview(
  configuration,
  workspace,
  state,
  targetSha,
  logPath,
) {
  const previous = state.lastAuditedSha;
  let previousAvailable = false;
  if (
    typeof previous === "string" &&
    previous !== targetSha &&
    /^[a-f0-9]{40}$/i.test(previous)
  ) {
    const available = git(
      configuration,
      workspace,
      ["cat-file", "-e", `${previous}^{commit}`],
      { logPath },
    );
    previousAvailable = available.code === 0;
  }
  let targetParentAvailable = true;
  if (!previousAvailable) {
    const available = git(
      configuration,
      workspace,
      ["cat-file", "-e", `${targetSha}^{commit}^`],
      { logPath },
    );
    targetParentAvailable = available.code === 0;
  }
  return reviewRange(
    previous,
    targetSha,
    previousAvailable,
    targetParentAvailable,
  );
}

export function reviewRange(
  previous,
  targetSha,
  previousAvailable,
  targetParentAvailable = true,
) {
  if (
    previousAvailable &&
    typeof previous === "string" &&
    previous !== targetSha &&
    /^[a-f0-9]{40}$/i.test(previous)
  ) {
    return `${previous}..${targetSha}`;
  }
  if (!targetParentAvailable) {
    throw new Error(
      "cannot review target because its parent is unavailable; a full-history clone is required",
    );
  }
  return `${targetSha}^..${targetSha}`;
}

function changedForRange(configuration, workspace, range, logPath) {
  const result = git(
    configuration,
    workspace,
    ["diff", "--name-only", "-z", range],
    { logPath, check: true },
  );
  return parseNulList(result.fullStdout);
}

export function baseBranchFromUpstream(upstream, branch) {
  if (!upstream)
    throw new Error(`checked-out branch ${branch} must track an origin branch`);
  const prefix = "origin/";
  if (!upstream.startsWith(prefix))
    throw new Error(`unsupported upstream ref: ${upstream}`);
  const baseBranch = upstream.slice(prefix.length);
  if (
    !baseBranch ||
    !/^[A-Za-z0-9._/-]+$/.test(baseBranch) ||
    baseBranch.includes("..")
  ) {
    throw new Error("base branch is invalid");
  }
  return baseBranch;
}

function runMaintenance(argv, expectedConfigurationFingerprint) {
  const args = parseMaintenanceArgs(argv);
  const configuration = loadConfiguration(args);
  if (
    !/^[a-f0-9]{64}$/.test(expectedConfigurationFingerprint ?? "") ||
    maintenanceConfigurationFingerprint(configuration) !==
      expectedConfigurationFingerprint
  ) {
    throw new Error(
      "maintenance configuration changed after the native lock was selected",
    );
  }
  mkdirSync(configuration.stateDir, { recursive: true, mode: 0o700 });
  chmodSync(configuration.stateDir, 0o700);

  const runId = nowIso().replace(/[-:.]/g, "").toLowerCase();
  const reportDir = join(configuration.stateDir, "reports");
  const runCacheRoot = maintenanceRunCacheRoot(configuration.stateDir);
  if (/\s/.test(runCacheRoot))
    throw new Error(
      "maintenance temporary directory cannot contain whitespace",
    );
  mkdirSync(reportDir, { recursive: true, mode: 0o700 });
  mkdirSync(configuration.cacheDir, { recursive: true, mode: 0o700 });
  mkdirSync(runCacheRoot, { recursive: true, mode: 0o700 });
  chmodSync(reportDir, 0o700);
  chmodSync(configuration.cacheDir, 0o700);
  chmodSync(runCacheRoot, 0o700);
  const removedReportTemps = removeAbandonedReportTemps(reportDir);
  const finalizedReports = finalizeInterruptedReports(reportDir);
  const removedRunRoots = scavengeAbandonedRunRoots(runCacheRoot);
  const logPath = join(reportDir, `run-${runId}.log`);
  const reportPath = join(reportDir, `report-${runId}.json`);
  const statePath = join(configuration.stateDir, "state.json");
  const report = {
    schemaVersion: maintenanceSchemaVersion,
    runId,
    startedAt: nowIso(),
    completedAt: null,
    outcome: "running",
    targetSha: null,
    baseBranch: null,
    operatorWorktreeDirty: null,
    initialGates: [],
    review: { summary: "not run", findings: [] },
    changedPaths: [],
    finalGates: [],
    pullRequest: null,
    error: null,
  };
  let runRoot = null;
  let exitCode = 1;
  let cleanupComplete = false;

  const saveReport = () => writeJsonAtomic(reportPath, report);
  const cleanupRunArtifacts = () => {
    if (cleanupComplete) return;
    cleanupComplete = true;
    try {
      if (runRoot) safeRemoveRunRoot(runRoot, runCacheRoot);
    } finally {
      rotateReports(reportDir);
    }
  };
  try {
    saveReport();
    if (
      removedReportTemps.length ||
      finalizedReports.length ||
      removedRunRoots.length
    ) {
      appendLog(
        logPath,
        `recovered ${finalizedReports.length} interrupted report(s), ${removedReportTemps.length} abandoned report temp file(s), and ${removedRunRoots.length} abandoned run root(s)`,
      );
    }
    git(
      configuration,
      configuration.repoPath,
      ["rev-parse", "--is-inside-work-tree"],
      { logPath, check: true },
    );
    const originRecord = git(
      configuration,
      configuration.repoPath,
      ["remote", "get-url", "origin"],
      { logPath, check: true, logOutput: false },
    );
    const observedOrigin = parseGitHubOrigin(
      stdoutLine(originRecord, "origin URL"),
    );
    if (
      configuration.repoSlug &&
      configuration.repoSlug !== observedOrigin.slug
    )
      throw new Error(
        "repository origin no longer matches the installed maintenance configuration",
      );
    configuration.repoSlug = observedOrigin.slug;
    configuration.originUrl = observedOrigin.url;
    git(configuration, configuration.repoPath, ["fetch", "--prune", "origin"], {
      logPath,
      check: true,
      allowCredentials: true,
    });
    report.operatorWorktreeDirty = Boolean(
      git(configuration, configuration.repoPath, ["status", "--porcelain=v1"], {
        logPath,
        check: true,
      }).fullStdout.trim(),
    );
    const branch = stdoutLine(
      git(
        configuration,
        configuration.repoPath,
        ["symbolic-ref", "--quiet", "--short", "HEAD"],
        { logPath, check: true },
      ),
      "checked-out branch",
    );
    const upstreamRecord = git(
      configuration,
      configuration.repoPath,
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
      { logPath },
    );
    const upstream =
      upstreamRecord.code === 0 ? upstreamRecord.fullStdout.trim() : "";
    report.baseBranch = baseBranchFromUpstream(upstream, branch);
    report.targetSha = stdoutLine(
      git(
        configuration,
        configuration.repoPath,
        ["rev-parse", `${upstream}^{commit}`],
        { logPath, check: true },
      ),
      "upstream commit",
    );
    if (!/^[a-f0-9]{40}$/i.test(report.targetSha))
      throw new Error("upstream did not resolve to a full commit SHA");

    const state = readState(statePath);
    if (!args.force && state.lastAuditedSha === report.targetSha) {
      report.outcome = "unchanged";
      report.completedAt = nowIso();
      saveReport();
      writeJsonAtomic(statePath, {
        ...state,
        lastRunAt: report.completedAt,
        lastOutcome: report.outcome,
        lastReport: reportPath,
      });
      exitCode = 0;
      return exitCode;
    }

    runRoot = mkdtempSync(join(runCacheRoot, "run-"));
    const workspaces = maintenanceWorkspacePlan(runRoot);
    const gateWorkspace = workspaces.initialGates;
    clonePinnedWorkspace(
      configuration,
      configuration.repoPath,
      gateWorkspace,
      report.targetSha,
      logPath,
    );
    report.initialGates = runGates(configuration, gateWorkspace, logPath, {
      requireCleanTree: true,
    });
    saveReport();

    const workspace = workspaces.remediation;
    clonePinnedWorkspace(
      configuration,
      configuration.repoPath,
      workspace,
      report.targetSha,
      logPath,
    );

    const range = rangeForReview(
      configuration,
      workspace,
      state,
      report.targetSha,
      logPath,
    );
    const changed = changedForRange(configuration, workspace, range, logPath);
    if (!args.skipReview) {
      report.review = runCodexReview(
        configuration,
        workspace,
        range,
        changed,
        runRoot,
        logPath,
      );
      saveReport();
    }

    if (!shouldAttemptRemediation(report.initialGates, report.review)) {
      report.outcome = args.skipReview
        ? "gates_passed_review_skipped"
        : "passed";
      exitCode = 0;
    } else if (args.auditOnly) {
      report.outcome = "action_required";
    } else {
      const fix = runCodexFix(
        configuration,
        workspace,
        report.initialGates,
        report.review,
        runRoot,
        logPath,
      );
      if (fix.code !== 0)
        throw new Error(`Codex remediation failed with exit code ${fix.code}`);
      const prepared = prepareValidatedPatch(
        configuration,
        workspace,
        runRoot,
        logPath,
      );
      report.changedPaths = prepared.paths;
      const validationWorkspace = workspaces.validation;
      git(
        configuration,
        configuration.repoPath,
        [
          "clone",
          "--local",
          "--no-hardlinks",
          "--no-checkout",
          configuration.repoPath,
          validationWorkspace,
        ],
        { logPath, check: true },
      );
      git(
        configuration,
        validationWorkspace,
        ["remote", "set-url", "origin", configuration.originUrl],
        { logPath, check: true },
      );
      git(
        configuration,
        validationWorkspace,
        ["checkout", "--detach", report.targetSha],
        { logPath, check: true },
      );
      git(
        configuration,
        validationWorkspace,
        ["apply", "--index", "--whitespace=error-all", prepared.patchPath],
        { logPath, check: true },
      );
      report.finalGates = runGates(configuration, validationWorkspace, logPath);
      if (!gatesPassed(report.finalGates))
        throw new Error("independent post-remediation gates failed");
      verifyExactValidatedPatch(
        configuration,
        validationWorkspace,
        prepared,
        logPath,
      );
      report.pullRequest = createPullRequest(
        configuration,
        validationWorkspace,
        report.baseBranch,
        report.targetSha,
        report,
        runRoot,
        logPath,
      );
      report.outcome = "pull_request_opened";
      exitCode = 0;
    }

    report.completedAt = nowIso();
    saveReport();
    const nextState = {
      schemaVersion: maintenanceSchemaVersion,
      lastRunAt: report.completedAt,
      lastOutcome: report.outcome,
      lastReport: reportPath,
      lastPullRequest: report.pullRequest?.url ?? state.lastPullRequest ?? null,
    };
    if (["passed", "pull_request_opened"].includes(report.outcome))
      nextState.lastAuditedSha = report.targetSha;
    else nextState.lastAuditedSha = state.lastAuditedSha ?? null;
    writeJsonAtomic(statePath, nextState);
  } catch (error) {
    report.outcome = "failed";
    report.error = safeError(error);
    report.completedAt = nowIso();
    saveReport();
    const state = readState(statePath);
    writeJsonAtomic(statePath, {
      ...state,
      schemaVersion: maintenanceSchemaVersion,
      lastRunAt: report.completedAt,
      lastOutcome: report.outcome,
      lastReport: reportPath,
    });
    appendLog(logPath, `maintenance failed: ${report.error}`);
    console.error(`Y2 maintenance failed: ${report.error}`);
  } finally {
    cleanupRunArtifacts();
  }
  return exitCode;
}

export function nativeLockArguments(
  stateDir,
  argv,
  nodePath = process.execPath,
  configurationFingerprint,
) {
  if (!/^[a-f0-9]{64}$/.test(configurationFingerprint ?? ""))
    throw new Error("maintenance configuration fingerprint is invalid");
  return [
    "-s",
    "-t",
    "0",
    "-k",
    join(stateDir, "run.lock"),
    nodePath,
    fileURLToPath(import.meta.url),
    nativeLockMarker,
    configurationFingerprint,
    ...argv,
  ];
}

export function runMaintenanceWithLock(argv = process.argv.slice(2)) {
  if (process.platform !== "darwin") {
    throw new Error("scheduled maintenance is supported only on macOS");
  }
  const configuration = loadConfiguration(parseMaintenanceArgs(argv));
  mkdirSync(configuration.stateDir, { recursive: true, mode: 0o700 });
  chmodSync(configuration.stateDir, 0o700);
  const lockPath = join(configuration.stateDir, "run.lock");
  writeFileSync(lockPath, "", { encoding: "utf8", flag: "a", mode: 0o600 });
  chmodSync(lockPath, 0o600);
  const result = spawnSync(
    "/usr/bin/lockf",
    nativeLockArguments(
      configuration.stateDir,
      argv,
      process.execPath,
      maintenanceConfigurationFingerprint(configuration),
    ),
    { stdio: "inherit", env: process.env },
  );
  if (result.error) throw result.error;
  if (result.status === 75) {
    console.log(
      "Y2 maintenance is already running; this invocation exited without overlap.",
    );
    return 0;
  }
  if (Number.isInteger(result.status)) return result.status;
  throw new Error(
    `native maintenance lock terminated unexpectedly${result.signal ? ` (${result.signal})` : ""}`,
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  try {
    const argv = process.argv.slice(2);
    process.exitCode =
      argv[0] === managedSubprocessMarker
        ? await runManagedSubprocess(argv.slice(1))
        : argv[0] === nativeLockMarker
          ? runMaintenance(argv.slice(2), argv[1])
          : runMaintenanceWithLock(argv);
  } catch (error) {
    console.error(`Y2 maintenance could not start: ${safeError(error)}`);
    process.exitCode = 1;
  }
}
