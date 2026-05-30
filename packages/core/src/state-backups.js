import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appHome } from "../../storage/src/paths.js";

const execFileAsync = promisify(execFile);

function nowIso() {
  return new Date().toISOString();
}

function clean(value = "") {
  return String(value || "").trim();
}

function safeSegment(value = "") {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96) || "backup";
}

function backupError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function deployRoot(env = process.env) {
  return path.resolve(clean(env.ORKESTR_DEPLOY_ROOT) || "/opt/orkestr");
}

export function stateBackupDir(env = process.env) {
  return path.resolve(clean(env.ORKESTR_DEPLOY_BACKUP_DIR) || path.join(deployRoot(env), "backups"));
}

function backupExcludes(env = process.env) {
  return (clean(env.ORKESTR_DEPLOY_BACKUP_EXCLUDES) || "run tmp whatsapp-bridge/sessions")
    .split(/\s+/g)
    .map((item) => item.replace(/^[/\\]+/g, "").replace(/\\/g, "/"))
    .filter(Boolean);
}

function assertSafeHome(home) {
  const resolved = path.resolve(home);
  if (!resolved || resolved === path.parse(resolved).root) throw backupError("unsafe_orkestr_home", 400);
  return resolved;
}

function backupName(target = "orkestr") {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `${stamp}-${safeSegment(target)}-state.tar.gz`;
}

function inside(parent, child) {
  const base = path.resolve(parent);
  const candidate = path.resolve(child);
  const relative = path.relative(base, candidate);
  return Boolean(base) && Boolean(candidate) && (!relative || (!relative.startsWith("..") && !path.isAbsolute(relative)));
}

function publicBackup(filePath, stats) {
  return {
    name: path.basename(filePath),
    path: filePath,
    size: stats.size,
    createdAt: stats.birthtime?.toISOString?.() || stats.mtime?.toISOString?.() || "",
    modifiedAt: stats.mtime?.toISOString?.() || "",
  };
}

export async function listStateBackups(env = process.env) {
  const dir = stateBackupDir(env);
  const entries = await fs.readdir(dir).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const backups = [];
  for (const entry of entries) {
    if (!entry.endsWith(".tar.gz")) continue;
    const filePath = path.join(dir, entry);
    const stats = await fs.stat(filePath).catch(() => null);
    if (!stats?.isFile()) continue;
    backups.push(publicBackup(filePath, stats));
  }
  backups.sort((left, right) => Date.parse(right.modifiedAt || right.createdAt || "") - Date.parse(left.modifiedAt || left.createdAt || ""));
  return backups;
}

export async function stateBackupStatus(env = process.env) {
  const home = assertSafeHome(appHome(env));
  const backupDir = stateBackupDir(env);
  const backups = await listStateBackups(env);
  return {
    ok: true,
    home,
    backupDir,
    backupCount: backups.length,
    latestBackup: backups[0] || null,
    backups,
    excludes: backupExcludes(env),
    restoreSupported: "plan-only",
    migration: {
      codexAppServer: {
        available: true,
        dryRunSupported: true,
        apiPath: "/api/codex/migrate",
        command: "orkestr codex migrate",
      },
    },
    generatedAt: nowIso(),
  };
}

export async function createStateBackup({ label = "" } = {}, env = process.env) {
  const home = assertSafeHome(appHome(env));
  const dir = stateBackupDir(env);
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, backupName(label || path.basename(home)));
  const parent = path.dirname(home);
  const base = path.basename(home);
  const args = ["-C", parent, "-czf", target];
  for (const exclude of backupExcludes(env)) args.push(`--exclude=${base}/${exclude}`);
  args.push(base);
  let warning = "";
  try {
    await execFileAsync("tar", args, { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  } catch (error) {
    const stderr = clean(error?.stderr || error?.message);
    const stats = await fs.stat(target).catch(() => null);
    if (/file changed as we read it/i.test(stderr) && stats?.isFile() && stats.size > 0) {
      warning = stderr;
    } else {
      await fs.rm(target, { force: true }).catch(() => {});
      throw backupError(stderr || "state_backup_failed", 500);
    }
  }
  const stats = await fs.stat(target);
  return {
    ok: true,
    backup: publicBackup(target, stats),
    warning,
    status: await stateBackupStatus(env),
  };
}

function shellQuote(value = "") {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

async function resolveBackupPath(inputPath = "", env = process.env) {
  const dir = stateBackupDir(env);
  const value = clean(inputPath);
  if (!value) throw backupError("backup_path_required", 400);
  const candidate = path.isAbsolute(value) ? path.resolve(value) : path.resolve(dir, value);
  if (!inside(dir, candidate)) throw backupError("backup_path_forbidden", 403);
  const stats = await fs.stat(candidate).catch(() => null);
  if (!stats?.isFile()) throw backupError("backup_not_found", 404);
  if (!candidate.endsWith(".tar.gz")) throw backupError("backup_type_unsupported", 400);
  return publicBackup(candidate, stats);
}

export async function stateRestorePlan({ backupPath = "", serviceName = "" } = {}, env = process.env) {
  const home = assertSafeHome(appHome(env));
  const backup = await resolveBackupPath(backupPath, env);
  const service = clean(serviceName || env.ORKESTR_SERVICE_NAME || "orkestr-ui.service");
  const parent = path.dirname(home);
  const preRestorePrefix = `${home}.pre-restore-`;
  return {
    ok: true,
    executable: false,
    reason: "restore_requires_operator_shell",
    backup,
    home,
    serviceName: service,
    commands: [
      `sudo systemctl stop ${shellQuote(service)}`,
      `sudo mkdir -p ${shellQuote(parent)}`,
      `if [ -d ${shellQuote(home)} ]; then sudo mv ${shellQuote(home)} ${shellQuote(preRestorePrefix)}$(date +%Y%m%d%H%M%S); fi`,
      `sudo tar -xzf ${shellQuote(backup.path)} -C ${shellQuote(parent)}`,
      `sudo systemctl start ${shellQuote(service)}`,
    ],
    generatedAt: nowIso(),
  };
}
