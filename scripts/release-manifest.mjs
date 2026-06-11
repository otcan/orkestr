#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function flagValue(argv, name, fallback = "") {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  return String(argv[index + 1] || "");
}

function hasFlag(argv, name) {
  return argv.includes(name);
}

async function gitValue(args, cwd) {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, timeout: 2000 });
    return String(stdout || "").trim();
  } catch {
    return "";
  }
}

function safeJsonValue(value) {
  return String(value || "").trim();
}

const argv = process.argv.slice(2);
if (hasFlag(argv, "--help") || hasFlag(argv, "-h")) {
  process.stdout.write(`Usage: scripts/release-manifest.mjs [--output FILE] [--cwd DIR] [--ref REF] [--channel CHANNEL]\n`);
  process.exit(0);
}

const cwd = path.resolve(flagValue(argv, "--cwd", process.cwd()));
const output = flagValue(argv, "--output", "");
const packageJson = JSON.parse(await fs.readFile(path.join(cwd, "package.json"), "utf8"));
const commit = safeJsonValue(flagValue(argv, "--commit")) || await gitValue(["rev-parse", "HEAD"], cwd);
const branch = safeJsonValue(flagValue(argv, "--branch")) || await gitValue(["branch", "--show-current"], cwd);
const tag = safeJsonValue(flagValue(argv, "--tag")) || await gitValue(["describe", "--tags", "--exact-match", "HEAD"], cwd);
const describe = safeJsonValue(flagValue(argv, "--describe")) || await gitValue(["describe", "--tags", "--always", "--dirty", "--long"], cwd);
const dirty = safeJsonValue(await gitValue(["status", "--porcelain"], cwd)) !== "";
const generatedAt = new Date().toISOString();
const shortCommit = commit.slice(0, 12);
const releaseVersion = safeJsonValue(packageJson.version) || "0.0.0";
const releaseId = safeJsonValue(flagValue(argv, "--release-id")) || [tag || safeJsonValue(flagValue(argv, "--ref")) || "release", shortCommit]
  .filter(Boolean)
  .join("-");
const releaseLabel = safeJsonValue(flagValue(argv, "--release-label")) || tag || (releaseVersion ? `v${releaseVersion}` : releaseId);

const manifest = {
  schemaVersion: 1,
  releaseId,
  releaseLabel,
  releaseVersion,
  buildId: releaseId,
  name: packageJson.name || "orkestr",
  version: releaseVersion,
  channel: safeJsonValue(flagValue(argv, "--channel")) || "manual",
  generatedAt,
  deployedAt: safeJsonValue(flagValue(argv, "--deployed-at")),
  serviceName: safeJsonValue(flagValue(argv, "--service")) || "",
  source: {
    repository: safeJsonValue(flagValue(argv, "--repo")),
    requestedRef: safeJsonValue(flagValue(argv, "--ref")),
  },
  git: {
    commit,
    shortCommit,
    branch,
    tag,
    describe,
    dirty,
  },
  components: {
    orkestr: {
      name: packageJson.name || "orkestr",
      version: packageJson.version || "0.0.0",
      commit,
      tag,
    },
  },
  compatibility: {
    stateSchema: 1,
    rollback: dirty ? "blocked_dirty_build" : "app_only",
  },
};

const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
if (output) {
  await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
  await fs.writeFile(output, serialized, "utf8");
} else {
  process.stdout.write(serialized);
}
