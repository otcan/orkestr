import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res } from "@nestjs/common";
import { listRuntimeLeases } from "../../../../../packages/core/src/runtime-leases.js";
import { getSetupStatus } from "../../../../../packages/core/src/setup.js";
import { systemDoctor } from "../../../../../packages/core/src/system-doctor.js";
import { whereAmI } from "../../../../../packages/core/src/whereiam.js";
import {
  approvePairingChallenge,
  createPairingChallenge,
  getPairingChallenge,
  listPairingChallenges,
  pairBrowser,
  rejectPairingChallenge,
  securityStatus,
  sessionCookieHeader,
} from "../../../../../packages/core/src/security.js";
import { publicConfig } from "../../../../../packages/storage/src/config.js";
import { ensureDataDirs } from "../../../../../packages/storage/src/paths.js";
import { listEvents } from "../../../../../packages/storage/src/store.js";

const execFileAsync = promisify(execFile);
let lastCpuSample: { idle: number; total: number } | null = null;

function pct(used: number, total: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((used / total) * 1000) / 10));
}

async function diskStatus() {
  const target = process.cwd() || "/";
  const stats = await fs.statfs(target).catch(() => null);
  if (!stats) return { path: target, total: 0, used: 0, free: 0, percent: 0 };
  const total = Number(stats.blocks || 0) * Number(stats.bsize || 0);
  const free = Number(stats.bavail || 0) * Number(stats.bsize || 0);
  const used = Math.max(0, total - free);
  return { path: target, total, used, free, percent: pct(used, total) };
}

async function processRows(sort = "cpu") {
  const sortColumn = sort === "rss" || sort === "memory" ? "-rss" : "-pcpu";
  const { stdout } = await execFileAsync("ps", [
    "-eo",
    "pid=,ppid=,user=,pcpu=,pmem=,rss=,comm=,args=",
    `--sort=${sortColumn}`,
  ], { maxBuffer: 1024 * 1024 });
  const rows = String(stdout || "").trim().split("\n").filter(Boolean).map((line) => {
    const parts = line.trim().split(/\s+/);
    const [pid, ppid, user, cpu, memory, rss, command, ...args] = parts;
    return {
      pid: Number(pid),
      ppid: Number(ppid),
      user,
      cpu: Number(cpu) || 0,
      memory: Number(memory) || 0,
      rss: (Number(rss) || 0) * 1024,
      command,
      args: args.join(" "),
    };
  }).filter((row) => row.command !== "ps" && row.pid !== process.pid).slice(0, 40);
  return { count: rows.length, processes: rows, generatedAt: new Date().toISOString() };
}

async function cpuPercent(fallback: number): Promise<number> {
  const stat = await fs.readFile("/proc/stat", "utf8").catch(() => "");
  const line = stat.split("\n")[0] || "";
  const values = line.trim().split(/\s+/).slice(1).map((value) => Number(value) || 0);
  if (values.length < 4) return fallback;
  const idle = values[3] + (values[4] || 0);
  const total = values.reduce((sum, value) => sum + value, 0);
  const current = { idle, total };
  const previous = lastCpuSample;
  lastCpuSample = current;
  if (!previous) return fallback;
  const deltaTotal = current.total - previous.total;
  const deltaIdle = current.idle - previous.idle;
  if (deltaTotal <= 0) return fallback;
  return pct(deltaTotal - deltaIdle, deltaTotal);
}

async function systemSnapshot() {
  const memoryTotal = os.totalmem();
  const memoryFree = os.freemem();
  const memoryUsed = Math.max(0, memoryTotal - memoryFree);
  const cpus = os.cpus().length || 1;
  const loadAverage = os.loadavg();
  const disk = await diskStatus();
  const processMemory = process.memoryUsage();
  const percent = await cpuPercent(pct(loadAverage[0], cpus));
  return {
    generatedAt: new Date().toISOString(),
    hostname: os.hostname(),
    platform: os.platform(),
    uptimeSeconds: os.uptime(),
    cpu: {
      count: cpus,
      model: os.cpus()[0]?.model || "unknown",
      percent,
    },
    cpuPercent: percent,
    loadAverage: {
      one: loadAverage[0],
      five: loadAverage[1],
      fifteen: loadAverage[2],
    },
    memory: {
      total: memoryTotal,
      free: memoryFree,
      used: memoryUsed,
      percent: pct(memoryUsed, memoryTotal),
    },
    disk,
    network: {
      rxRateBps: 0,
      txRateBps: 0,
      note: "network rates require an overlay metrics adapter",
    },
    diskIo: {
      readBps: 0,
      writeBps: 0,
      utilPercent: 0,
      note: "disk IO rates require an overlay metrics adapter",
    },
    orkestr: {
      pid: process.pid,
      uptimeSeconds: process.uptime(),
      rss: processMemory.rss,
      heapUsed: processMemory.heapUsed,
      heapTotal: processMemory.heapTotal,
    },
  };
}

async function directoryExists(candidate: string): Promise<boolean> {
  return Boolean(await fs.stat(candidate).then((stats) => stats.isDirectory()).catch(() => false));
}

function uniqueResolvedPaths(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const resolved = path.resolve(String(value || "").trim());
    if (!resolved || seen.has(resolved)) continue;
    seen.add(resolved);
    result.push(resolved);
  }
  return result;
}

function rootLabel(root: string, pathsHome: string): string {
  if (root === path.join(pathsHome, "workspaces")) return "Orkestr workspaces";
  if (root === process.env.ORKESTR_RUNTIME_WORKSPACE_ROOT) return "Runtime workspace root";
  if (root === process.env.ORKESTR_CLONE_ROOT) return "Clone root";
  if (root === process.cwd()) return "Orkestr checkout";
  if (root === path.dirname(process.cwd())) return "Checkout parent";
  return root;
}

async function workspaceFolderRoots() {
  const paths = await ensureDataDirs();
  const candidates = uniqueResolvedPaths([
    process.env.ORKESTR_RUNTIME_WORKSPACE_ROOT || "",
    process.env.ORKESTR_CLONE_ROOT || "",
    paths.workspaces,
    "/workspace",
    "/workspaces",
    path.dirname(process.cwd()),
    process.cwd(),
  ]);
  const roots: Array<{ name: string; path: string }> = [];
  for (const candidate of candidates) {
    if (await directoryExists(candidate)) {
      roots.push({ name: rootLabel(candidate, paths.home), path: candidate });
    }
  }
  return roots.length ? roots : [{ name: "Orkestr workspaces", path: paths.workspaces }];
}

async function workspaceFolderListing(rawPath = "") {
  const roots = await workspaceFolderRoots();
  const requestedPath = String(rawPath || "").trim();
  let currentPath = path.resolve(requestedPath || roots[0]?.path || process.cwd());
  if (!(await directoryExists(currentPath))) {
    return {
      ok: false,
      error: "directory_not_found",
      path: currentPath,
      parent: path.dirname(currentPath),
      roots,
      entries: [],
    };
  }

  let entries: Array<{ name: string; path: string; hidden: boolean }> = [];
  let error = "";
  try {
    const rows = await fs.readdir(currentPath, { withFileTypes: true });
    entries = rows
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        name: entry.name,
        path: path.join(currentPath, entry.name),
        hidden: entry.name.startsWith("."),
      }))
      .sort((a, b) => Number(a.hidden) - Number(b.hidden) || a.name.localeCompare(b.name))
      .slice(0, 200);
  } catch (readError) {
    error = String((readError as Error)?.message || readError || "directory_unreadable");
  }

  return {
    ok: !error,
    error,
    path: currentPath,
    parent: currentPath === path.dirname(currentPath) ? null : path.dirname(currentPath),
    roots,
    entries,
  };
}

@Controller("api")
export class SystemController {
  @Get("health")
  health() {
    return { ok: true, name: "orkestr", generatedAt: new Date().toISOString() };
  }

  @Get("version")
  async version() {
    const pkg = JSON.parse(await fs.readFile(path.resolve(process.cwd(), "package.json"), "utf8"));
    return {
      name: pkg.name || "orkestr",
      version: pkg.version || "0.0.0",
      generatedAt: new Date().toISOString(),
    };
  }

  @Get("ready")
  async ready() {
    const status = await getSetupStatus();
    return {
      ok: true,
      dataHome: await this.dataDirReady(),
      setupState: status.setupState,
      overlayValid: status.overlay.valid,
      generatedAt: new Date().toISOString(),
    };
  }

  @Get("setup/status")
  async setupStatus() {
    return { ...(await getSetupStatus()), config: await publicConfig() };
  }

  @Get("setup/security/status")
  async setupSecurityStatus() {
    return { security: await securityStatus() };
  }

  @Post("setup/security/challenge")
  @HttpCode(200)
  async setupSecurityChallenge(@Req() request: any) {
    return createPairingChallenge({ request } as any);
  }

  @Post("setup/security/challenges")
  @HttpCode(200)
  async setupSecurityChallenges(@Req() request: any) {
    return createPairingChallenge({ request } as any);
  }

  @Get("setup/security/challenges")
  async listSetupSecurityChallenges() {
    return listPairingChallenges();
  }

  @Get("setup/security/challenges/:challengeId")
  async setupSecurityChallengeStatus(@Param("challengeId") challengeId: string) {
    return { ok: true, challenge: await getPairingChallenge(challengeId) };
  }

  @Post("setup/security/challenges/:challengeId/approve")
  @HttpCode(200)
  async approveSetupSecurityChallenge(@Param("challengeId") challengeId: string) {
    return approvePairingChallenge(challengeId, { approvedBy: "browser" });
  }

  @Post("setup/security/challenges/:challengeId/reject")
  @HttpCode(200)
  async rejectSetupSecurityChallenge(@Param("challengeId") challengeId: string) {
    return rejectPairingChallenge(challengeId, { rejectedBy: "browser" });
  }

  @Post("setup/security/pair")
  @HttpCode(200)
  async setupSecurityPair(@Body() body: Record<string, unknown> = {}, @Req() request: any, @Res({ passthrough: true }) response: any) {
    const result = await pairBrowser({
      challengeId: String(body.challengeId || ""),
      userAgent: String(request?.headers?.["user-agent"] || ""),
    } as any);
    response.setHeader("set-cookie", sessionCookieHeader(result.token));
    return {
      ok: true,
      session: result.session,
      security: await securityStatus(),
    };
  }

  @Get("events")
  async events(@Query("limit") limit = "100") {
    return { events: await listEvents(process.env, Number(limit || 100)) };
  }

  @Get("runtime-leases")
  async runtimeLeases() {
    return { leases: await listRuntimeLeases(), budget: { maxLiveThreads: Number(process.env.ORKESTR_MAX_LIVE_THREADS || 20) } };
  }

  @Get("whereiam")
  async whereiam(
    @Query("cwd") cwd = "",
    @Query("threadId") threadId = "",
    @Query("sessionName") sessionName = "",
    @Query("paneId") paneId = "",
  ) {
    return whereAmI({
      cwd: String(cwd || ""),
      threadId: String(threadId || ""),
      sessionName: String(sessionName || ""),
      paneId: String(paneId || ""),
    });
  }

  @Get("system")
  async system() {
    return systemSnapshot();
  }

  @Get("system/summary")
  async systemSummary() {
    return systemSnapshot();
  }

  @Get("system/doctor")
  async systemDoctor() {
    return systemDoctor();
  }

  @Get("system/processes")
  async systemProcesses(@Query("sort") sort = "cpu") {
    return processRows(String(sort || "cpu"));
  }

  @Get("system/workspace-folders")
  async workspaceFolders(@Query("path") currentPath = "") {
    return workspaceFolderListing(String(currentPath || ""));
  }

  private async dataDirReady() {
    const paths = await ensureDataDirs();
    const probe = path.join(paths.home, ".ready-check");
    await fs.writeFile(probe, new Date().toISOString());
    await fs.unlink(probe).catch(() => {});
    return paths.home;
  }
}

@Controller("api/models")
export class ModelsController {
  @Get("status")
  status() {
    return {
      generatedAt: new Date().toISOString(),
      codex: {
        model: process.env.ORKESTR_DEFAULT_CODEX_MODEL || process.env.OPENAI_MODEL || null,
        reasoningEffort: process.env.ORKESTR_DEFAULT_CODEX_REASONING || null,
      },
      ollama: {
        ok: false,
        baseUrl: process.env.OLLAMA_HOST || "http://127.0.0.1:11434",
        models: [],
        note: "local model discovery is overlay-provided in OSS v1",
      },
      external: {
        configured: Boolean(process.env.OPENAI_API_KEY || process.env.OPENAI_BASE_URL),
        baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
        defaultModel: process.env.OPENAI_MODEL || null,
      },
    };
  }

  @Post("run")
  @HttpCode(501)
  run(@Body() _body: Record<string, unknown> = {}) {
    return {
      ok: false,
      error: "model_runner_not_configured",
      message: "The generic OSS build exposes model status; model execution should be provided by an overlay adapter.",
    };
  }
}
