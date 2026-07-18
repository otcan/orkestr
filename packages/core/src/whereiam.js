import path from "node:path";
import fs from "node:fs/promises";
import { listBrowserSessions } from "../../browsers/src/browsers.js";
import { ensureDataDirs } from "../../storage/src/paths.js";
import { getApiSessionBinding } from "./api-session-bindings.js";
import { publicPrincipal } from "./principal.js";
import { listRuntimeLeases, runtimeStatus } from "./runtime-leases.js";
import { readRuntimeSettings } from "./runtime-settings.js";
import { isAdminPrincipal } from "./policy.js";
import { listThreads, listThreadsForPrincipal, updateThread } from "./threads.js";
import { containedUserPolicyPath, tenantIsolationBoundary, threadUsesContainedUserPolicy } from "./tenant-policy.js";
import { tenantPublicUrls } from "./tenant-public-urls.js";
import { adminUserId, normalizeUserId } from "./users.js";
import { builtinUserSkillDefinitions, userScopedCapabilityHints } from "./user-skills.js";

const desktopInventoryLiveCache = new Map();

function nowIso() {
  return new Date().toISOString();
}

function clean(value) {
  return String(value || "").trim();
}

function positiveDurationMs(value, fallback, min = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, parsed);
}

function desktopInventoryCacheTtlMs(env = process.env) {
  return positiveDurationMs(env.ORKESTR_DESKTOP_INVENTORY_CACHE_MS || env.ORKESTR_BROWSER_SESSIONS_CACHE_MS, 15_000, 0);
}

function desktopInventoryCacheKey(principal = null, env = process.env) {
  return JSON.stringify({
    home: clean(env.ORKESTR_HOME),
    mode: clean(env.ORKESTR_BROWSER_DESKTOP_MODE),
    browserctlPath: clean(env.ORKESTR_BROWSERCTL_PATH || env.ORKESTR_BROWSERCTL),
    userId: clean(principal?.userId),
    role: clean(principal?.role),
  });
}

async function cachedBrowserSessions(env = process.env, options = {}) {
  const ttlMs = desktopInventoryCacheTtlMs(env);
  if (ttlMs <= 0) return listBrowserSessions(env, options);
  const key = desktopInventoryCacheKey(options.principal, env);
  const cached = desktopInventoryLiveCache.get(key);
  const now = Date.now();
  if (cached?.payload && cached.expiresAt > now) return cached.payload;
  if (cached?.inFlight) return cached.inFlight;
  const inFlight = listBrowserSessions(env, options)
    .then((payload) => {
      desktopInventoryLiveCache.set(key, { payload, expiresAt: Date.now() + ttlMs, inFlight: null });
      return payload;
    })
    .catch((error) => {
      desktopInventoryLiveCache.delete(key);
      throw error;
    });
  desktopInventoryLiveCache.set(key, {
    payload: cached?.payload || null,
    expiresAt: cached?.expiresAt || 0,
    inFlight,
  });
  return inFlight;
}

function publicThreadName(thread = {}) {
  return clean(thread.bindingName || thread.binding?.displayName || thread.name || thread.title || thread.id);
}

function codexThreadId(thread = {}) {
  return clean(thread.executor?.codexThreadId || thread.codexThreadId);
}

function codexModeValue(value) {
  const mode = clean(value).toLowerCase();
  return mode === "code" || mode === "plan" ? mode : "";
}

function liveCodexMode(thread = null, status = null) {
  return codexModeValue(status?.codexMode) ||
    codexModeValue(status?.progress?.codexMode) ||
    codexModeValue(thread?.runtime?.progress?.codexMode);
}

function resolvedCodexMode(thread = null, status = null) {
  return liveCodexMode(thread, status) || codexModeValue(thread?.codexMode) || null;
}

function resolvedCodexModeSource(thread = null, status = null) {
  if (liveCodexMode(thread, status)) return clean(status?.codexModeSource) || "runtime-pane";
  return clean(thread?.codexModeSource) || null;
}

async function syncLiveCodexMode(thread = null, status = null, env = process.env) {
  const mode = liveCodexMode(thread, status);
  if (!thread?.id || !mode) return thread;
  const source = resolvedCodexModeSource(thread, status) || "runtime-pane";
  if (thread.codexMode === mode && thread.codexModeSource === source) return thread;
  return updateThread(thread.id, {
    codexMode: mode,
    codexModeSource: source,
    codexModeUpdatedAt: nowIso(),
  }, env).catch(() => thread);
}

function resolvePath(value) {
  const text = clean(value);
  if (!text) return "";
  return path.resolve(text);
}

async function realOrResolved(value) {
  const resolved = resolvePath(value);
  if (!resolved) return "";
  return fs.realpath(resolved).catch(() => resolved);
}

function isPathInside(parent, child) {
  const base = resolvePath(parent);
  const candidate = resolvePath(child);
  if (!base || !candidate) return false;
  if (candidate === base) return true;
  const relative = path.relative(base, candidate);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function addCandidate(candidates, seen, label, value, score) {
  const resolved = resolvePath(value);
  if (!resolved || seen.has(`${label}\n${resolved}`)) return;
  seen.add(`${label}\n${resolved}`);
  candidates.push({ label, path: resolved, score });
}

function threadPathCandidates(thread = {}, lease = null) {
  const candidates = [];
  const seen = new Set();
  addCandidate(candidates, seen, "runtime.workspace", lease?.workspace || thread.runtime?.workspace, 120);
  addCandidate(candidates, seen, "thread.worktreePath", thread.worktreePath || thread.executor?.metadata?.worktreePath, 115);
  addCandidate(candidates, seen, "thread.cwd", thread.cwd || thread.executor?.metadata?.cwd, 110);
  addCandidate(candidates, seen, "thread.workspace", thread.workspace, 105);
  addCandidate(candidates, seen, "thread.repoPath", thread.repoPath || thread.executor?.metadata?.repoPath, 95);
  return candidates;
}

function scorePathMatch(candidate, cwd) {
  if (!candidate.path || !cwd) return null;
  if (candidate.path === cwd) return { ...candidate, exact: true, score: candidate.score + 50 };
  if (!isPathInside(candidate.path, cwd)) return null;
  const depth = path.relative(candidate.path, cwd).split(path.sep).filter(Boolean).length;
  return { ...candidate, exact: false, score: candidate.score - Math.min(depth, 20) };
}

function publicRuntime(lease = null, status = null) {
  if (!lease && !status) return null;
  return {
    id: status?.lease?.id || lease?.id || null,
    state: status?.state || lease?.state || null,
    sessionName: status?.sessionName || lease?.sessionName || null,
    paneId: status?.paneId || lease?.paneId || null,
    windowName: status?.windowName || lease?.windowName || null,
    workspace: status?.lease?.workspace || lease?.workspace || null,
    resourceClass: status?.lease?.resourceClass || lease?.resourceClass || null,
    reason: status?.lease?.reason || lease?.reason || null,
    startedAt: status?.lease?.startedAt || lease?.startedAt || null,
    heartbeatAt: status?.lease?.heartbeatAt || lease?.heartbeatAt || null,
    codexMode: liveCodexMode({ runtime: { progress: status?.progress || null } }, status) || null,
    codexModeSource: status?.codexModeSource || null,
    progress: status?.progress || null,
  };
}

function publicThread(thread = null, status = null) {
  if (!thread) return null;
  const liveMode = liveCodexMode(thread, status) || null;
  return {
    id: thread.id,
    name: thread.name || null,
    title: thread.title || null,
    displayName: publicThreadName(thread),
    bindingName: thread.bindingName || null,
    state: thread.state || null,
    wakePolicy: thread.wakePolicy || null,
    parentThreadId: thread.parentThreadId || null,
    rootThreadId: thread.rootThreadId || null,
    workerLabel: thread.workerLabel || null,
    workerIndex: thread.workerIndex || null,
    codexThreadId: codexThreadId(thread) || null,
    codexMode: resolvedCodexMode(thread, status),
    codexModeSource: resolvedCodexModeSource(thread, status),
    codexModeLive: liveMode,
  };
}

function publicWorkspace(thread = null, lease = null, cwd = "") {
  return {
    cwd: cwd || null,
    runtimeWorkspace: lease?.workspace || thread?.runtime?.workspace || thread?.workspace || thread?.cwd || null,
    threadWorkspace: thread?.workspace || null,
    threadCwd: thread?.cwd || null,
    repoPath: thread?.repoPath || thread?.executor?.metadata?.repoPath || lease?.repoPath || null,
    worktreePath: thread?.worktreePath || thread?.executor?.metadata?.worktreePath || lease?.worktreePath || null,
    branchName: thread?.branchName || lease?.branchName || null,
    baseBranch: thread?.baseBranch || lease?.baseBranch || null,
    remoteBranch: thread?.remoteBranch || null,
    baseCommit: thread?.baseCommit || lease?.baseCommit || null,
  };
}

function commandHints() {
  return {
    whereiam: "orkestr whereiam --json",
    bindApiSession: "orkestr api-session bind --api-session-id <stable-id>",
    postApiSessionMessage: "orkestr api-session message \"<message>\" --api-session-id <stable-id>",
    listThreads: "orkestr list",
    sendThreadInput: "orkestr send <thread-name-or-id> \"<message>\"",
    timers: "orkestr timers list",
    timerDoctor: "orkestr doctor timers",
    browserSessions: "curl \"$ORKESTR_API_BASE/api/browser-sessions\"",
    desktopLeases: "curl \"$ORKESTR_API_BASE/api/desktops/leases\"",
    sanitizerCheck: "orkestr sanitizer check --action <action> --text <description> [--url <url>] --json",
    whatsappStatus: "orkestr whatsapp accounts list --json",
    connectorStatus: "orkestr status --json",
  };
}

function safeUrl(value = "", { localOnly = false } = {}) {
  const text = clean(value);
  if (!text) return "";
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return "";
  }
  if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) return "";
  if (parsed.username || parsed.password) return "";
  if (localOnly) {
    const host = parsed.hostname.toLowerCase();
    if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) return "";
  }
  return parsed.toString();
}

function safeLease(lease = null) {
  if (!lease || typeof lease !== "object") return null;
  return {
    desktopSlug: clean(lease.desktopSlug),
    ownerUserId: clean(lease.ownerUserId),
    threadId: clean(lease.threadId),
    threadName: clean(lease.threadName || lease.ownerThreadLabel),
    mode: clean(lease.mode),
    stale: lease.stale === true,
    stealable: lease.stealable === true,
    acquiredAt: clean(lease.acquiredAt),
    heartbeatAt: clean(lease.heartbeatAt),
    expiresAt: clean(lease.expiresAt),
  };
}

function desktopActions(session = {}) {
  const control = session.control && typeof session.control === "object" ? session.control : {};
  const actions = new Set(["status"]);
  const openUrl = safeUrl(session.desk_url || session.url);
  const cdpUrl = safeUrl(session.cdp_url || session.cdpUrl, { localOnly: true });
  const controllable = Boolean(cdpUrl || control.start === true);
  if (openUrl || control.start === true) actions.add("open");
  if (control.prepare === true || control.health === true) actions.add("prepare");
  if (control.start === true) actions.add("start");
  if (control.stop === true) actions.add("stop");
  if (control.restart === true) actions.add("restart");
  if (control.start === true) actions.add("open_url");
  if (controllable) {
    actions.add("observe");
    actions.add("navigate");
    actions.add("click");
    actions.add("type");
    actions.add("extract");
  }
  return [...actions];
}

function publicDesktopRecord(session = {}) {
  const slug = clean(session.slug || session.id);
  const cdpUrl = safeUrl(session.cdp_url || session.cdpUrl, { localOnly: true });
  return {
    slug,
    id: slug,
    label: clean(session.label || slug || "Desktop"),
    type: clean(session.type || "desktop"),
    access: clean(session.access || "desktop"),
    state: clean(session.state || session.status || "unknown"),
    status: clean(session.status || session.state || "unknown"),
    url: safeUrl(session.desk_url || session.url),
    localControl: cdpUrl ? { cdpUrl, localOnly: true } : null,
    debugPort: Number(session.debugPort || session.debug_port || 0) || null,
    availableActions: desktopActions(session),
    control: {
      prepare: session.control?.prepare === true || session.control?.health === true,
      start: session.control?.start === true,
      stop: session.control?.stop === true,
      restart: session.control?.restart === true,
    },
    lease: safeLease(session.lease),
    leased: session.leased === true,
    leaseOwnerThreadId: clean(session.leaseOwnerThreadId),
    leaseOwnerLabel: clean(session.leaseOwnerLabel),
    notes: clean(session.notes || session.purpose).slice(0, 1000),
    workspacePath: clean(session.workspacePath || session.workspace),
    source: clean(session.source),
  };
}

function configuredDesktopRecord(item = {}, settings = {}) {
  const slug = clean(item.slug || item.id);
  const cdpUrl = safeUrl(item.cdpUrl || item.cdp_url, { localOnly: true });
  const availableActions = new Set(["status"]);
  if (safeUrl(item.url || item.deskUrl || item.desk_url)) availableActions.add("open");
  if (cdpUrl) {
    for (const action of ["observe", "navigate", "click", "type", "extract"]) availableActions.add(action);
  }
  return {
    slug,
    id: slug,
    label: clean(item.label || item.title || slug || "Desktop"),
    type: clean(item.type || "desktop"),
    access: clean(item.access || "desktop"),
    state: settings?.enabled === false || settings?.provisioned === false ? "not_provisioned" : clean(item.state || item.status || "known"),
    status: settings?.enabled === false || settings?.provisioned === false ? "not_provisioned" : clean(item.status || item.state || "known"),
    url: safeUrl(item.url || item.deskUrl || item.desk_url),
    localControl: cdpUrl ? { cdpUrl, localOnly: true } : null,
    debugPort: Number(item.debugPort || item.debug_port || 0) || null,
    availableActions: [...availableActions],
    control: {
      prepare: item.control?.prepare === true,
      start: item.control?.start === true,
      stop: item.control?.stop === true,
      restart: item.control?.restart === true,
    },
    lease: null,
    leased: false,
    leaseOwnerThreadId: "",
    leaseOwnerLabel: "",
    notes: clean(item.purpose || item.notes || item.description).slice(0, 1000),
    workspacePath: clean(item.workspacePath || item.workspace),
    source: "runtime-settings",
  };
}

function desktopSettingsItems(settings = {}) {
  const desktops = settings?.desktops && typeof settings.desktops === "object" ? settings.desktops : {};
  const items = Array.isArray(desktops.items)
    ? desktops.items
    : Array.isArray(desktops.catalog)
      ? desktops.catalog
      : Array.isArray(desktops.desktops)
        ? desktops.desktops
        : [];
  return items
    .map((item) => configuredDesktopRecord(item, desktops))
    .filter((desktop) => desktop.slug);
}

function mergeDesktopRecords(known = [], live = []) {
  const bySlug = new Map();
  for (const desktop of known) bySlug.set(desktop.slug, desktop);
  for (const desktop of live) {
    const prior = bySlug.get(desktop.slug) || {};
    bySlug.set(desktop.slug, {
      ...prior,
      ...desktop,
      label: clean(desktop.label) || clean(prior.label) || desktop.slug,
      notes: clean(desktop.notes) || clean(prior.notes),
      workspacePath: clean(desktop.workspacePath) || clean(prior.workspacePath),
      localControl: desktop.localControl || prior.localControl || null,
      availableActions: [...new Set([...(prior.availableActions || []), ...(desktop.availableActions || [])])],
    });
  }
  return [...bySlug.values()];
}

async function desktopInventoryContext(principal = null, settings = {}, env = process.env) {
  const desktopSettings = settings?.desktops && typeof settings.desktops === "object" ? settings.desktops : {};
  const known = desktopSettingsItems(settings);
  let payload = null;
  let live = [];
  let error = "";
  let message = "";
  try {
    payload = await cachedBrowserSessions(env, { principal });
    live = (payload?.sessions || []).map(publicDesktopRecord).filter((desktop) => desktop.slug);
  } catch (caught) {
    error = clean(caught?.message || caught || "desktop_inventory_failed");
    message = clean(caught?.publicMessage || caught?.message || caught || "Desktop inventory failed.");
  }
  const desktops = mergeDesktopRecords(known, live);
  return {
    ok: payload ? payload.ok !== false : known.length > 0,
    liveOk: Boolean(payload && payload.ok !== false),
    source: clean(payload?.source) || (known.length ? "runtime-settings" : "browser"),
    error: clean(payload?.error) || error,
    message: clean(payload?.message) || message,
    defaults: {
      default: clean(desktopSettings.default),
      gmailAuth: clean(desktopSettings.gmailAuth),
      manualIntervention: clean(desktopSettings.manualIntervention),
      mode: clean(desktopSettings.mode),
      enabled: desktopSettings.enabled !== false,
      provisioned: desktopSettings.provisioned !== false,
    },
    desktops,
    known,
    live,
  };
}

async function capabilityHints(thread = null, options = {}, env = process.env) {
  const ownerUserId = normalizeUserId(options.ownerUserId || thread?.ownerUserId || thread?.userId || env.ORKESTR_ADMIN_USER_ID || adminUserId);
  if (threadUsesContainedUserPolicy(thread || { ownerUserId }, env)) {
    return userScopedCapabilityHints({ userId: ownerUserId, thread: thread || { ownerUserId } }, env);
  }
  const enabledSkills = builtinUserSkillDefinitions().map((definition) => definition.id);
  return {
    threads: true,
    whereiam: true,
    files: true,
    timers: true,
    virtualBrowsers: true,
    desktopLeases: true,
    whatsapp: true,
    gmail: true,
    outlook: true,
    linkedin: true,
    learning: true,
    hostSkills: true,
    globalConnectorAccounts: true,
    privateOperatorData: true,
    skillRegistry: {
      userId: ownerUserId,
      source: "admin-defaults",
      userFound: true,
    },
    enabledSkills,
    disabledSkills: [],
    skills: builtinUserSkillDefinitions().map((skill) => ({
      id: skill.id,
      label: skill.label,
      category: skill.category,
      enabled: true,
      scopes: [...skill.scopes],
      requiresConnector: clean(skill.requiresConnector),
      requiresDesktop: clean(skill.requiresDesktop),
    })),
  };
}

function apiBase(env = process.env) {
  if (env.ORKESTR_API_BASE) return clean(env.ORKESTR_API_BASE).replace(/\/+$/g, "");
  const rawHost = clean(env.ORKESTR_HOST || "127.0.0.1").toLowerCase();
  const host = !rawHost || ["0.0.0.0", "::", "[::]", "*"].includes(rawHost) ? "127.0.0.1" : env.ORKESTR_HOST || "127.0.0.1";
  const port = env.ORKESTR_PORT || env.PORT || "19812";
  return `http://${host}:${port}`;
}

export async function whereAmI(input = {}, env = process.env) {
  const paths = await ensureDataDirs(env);
  const settings = await readRuntimeSettings(env);
  const rawCwd = clean(input.cwd) || process.cwd();
  const cwd = await realOrResolved(rawCwd);
  const requestedApiSessionId = clean(input.apiSessionId || input.sessionId || input.codexApiSessionId);
  const apiSessionBinding = requestedApiSessionId ? await getApiSessionBinding(requestedApiSessionId, env).catch(() => null) : null;
  const requestedThreadId = clean(input.threadId || input.orkestrThreadId || apiSessionBinding?.threadId);
  const requestedThreadFromApiSession = Boolean(!clean(input.threadId || input.orkestrThreadId) && apiSessionBinding?.threadId);
  const requestedSessionName = clean(input.sessionName);
  const requestedPaneId = clean(input.paneId || input.tmuxPaneId);
  const principal = input.principal || null;
  const threads = principal ? await listThreadsForPrincipal(principal, env) : await listThreads(env);
  const leases = await listRuntimeLeases(env);
  const activeLeases = leases.filter((lease) => !lease.endedAt);
  const leaseByThreadId = new Map(activeLeases.map((lease) => [lease.threadId, lease]));

  let match = null;
  let matchedBy = "";

  if (requestedThreadId) {
    const thread = threads.find((item) => [item.id, item.name, item.bindingName].includes(requestedThreadId)) || null;
    if (thread) {
      match = { thread, lease: leaseByThreadId.get(thread.id) || null, score: 1000 };
      matchedBy = requestedThreadFromApiSession ? "apiSessionId" : "threadId";
    }
  }

  if (!match && (requestedSessionName || requestedPaneId)) {
    const lease = activeLeases.find((item) =>
      (requestedSessionName && item.sessionName === requestedSessionName) ||
      (requestedPaneId && item.paneId === requestedPaneId)
    ) || null;
    const thread = lease ? threads.find((item) => item.id === lease.threadId) || null : null;
    if (thread) {
      match = { thread, lease, score: 900 };
      matchedBy = requestedPaneId && lease.paneId === requestedPaneId ? "paneId" : "sessionName";
    }
  }

  if (!match && cwd) {
    const scored = [];
    for (const thread of threads) {
      const lease = leaseByThreadId.get(thread.id) || null;
      for (const candidate of threadPathCandidates(thread, lease)) {
        const candidatePath = await realOrResolved(candidate.path);
        const pathMatch = scorePathMatch({ ...candidate, path: candidatePath }, cwd);
        if (pathMatch) scored.push({ thread, lease, match: pathMatch, score: pathMatch.score });
      }
    }
    scored.sort((left, right) => right.score - left.score);
    if (scored[0]) {
      match = scored[0];
      matchedBy = scored[0].match.label;
    }
  }

  let thread = match?.thread || null;
  const lease = match?.lease || null;
  const status = thread ? await runtimeStatus(thread.id, env).catch(() => null) : null;
  thread = await syncLiveCodexMode(thread, status, env);
  const principalIsUser = principal && String(principal.role || "").toLowerCase() !== "admin";
  const owner = normalizeUserId(thread?.ownerUserId || (principalIsUser ? principal.userId : "") || env.ORKESTR_ADMIN_USER_ID || adminUserId);
  const scoped = Boolean(principal && !isAdminPrincipal(principal));
  const sanitizerRequired = scoped;
  const containedPolicy = threadUsesContainedUserPolicy(thread || { ownerUserId: owner }, env);
  const desktops = await desktopInventoryContext(principal, settings, env);
  return {
    ok: Boolean(thread),
    matched: Boolean(thread),
    matchedBy: matchedBy || null,
    cwd,
    apiBase: apiBase(env),
    publicUrls: tenantPublicUrls({
      tenantVmId: env.ORKESTR_TENANT_VM_ID,
      brokerInstanceId: env.ORKESTR_BROKER_INSTANCE_ID || env.ORKESTR_INSTANCE_ID,
    }, env),
    dataHome: paths.home,
    thread: publicThread(thread, status),
    user: publicPrincipal(principal) || {
      kind: "user",
      userId: owner,
      role: "admin",
      source: "thread-owner",
      displayName: null,
    },
    tenancy: {
      ownerUserId: owner,
      scoped,
      sanitizerRequired,
      sanitizerFallback: false,
      isolationBoundary: tenantIsolationBoundary(thread || { ownerUserId: owner }, env),
      runtimePolicy: containedPolicy
        ? {
            id: "contained-user-runtime",
            source: "server",
            path: containedUserPolicyPath(env),
            writableByWorkspace: false,
            injectedAs: "developerInstructions",
          }
        : null,
    },
    workspace: publicWorkspace(thread, lease, cwd),
    runtime: publicRuntime(lease, status),
    desktops,
    settings,
    capabilities: await capabilityHints(thread || { ownerUserId: owner }, { ownerUserId: owner }, env),
    apiSession: requestedApiSessionId
      ? {
          id: requestedApiSessionId,
          bound: Boolean(thread && apiSessionBinding && apiSessionBinding.threadId === thread.id),
          threadId: thread && apiSessionBinding?.threadId === thread.id ? thread.id : null,
          createdAt: thread && apiSessionBinding?.threadId === thread.id ? clean(apiSessionBinding.createdAt) || null : null,
          updatedAt: thread && apiSessionBinding?.threadId === thread.id ? clean(apiSessionBinding.updatedAt) || null : null,
          lastSeenAt: thread && apiSessionBinding?.threadId === thread.id ? clean(apiSessionBinding.lastSeenAt) || null : null,
        }
      : null,
    commands: commandHints(),
    generatedAt: nowIso(),
  };
}
