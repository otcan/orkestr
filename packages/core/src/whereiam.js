import path from "node:path";
import fs from "node:fs/promises";
import { ensureDataDirs } from "../../storage/src/paths.js";
import { getApiSessionBinding } from "./api-session-bindings.js";
import { publicPrincipal } from "./principal.js";
import { listRuntimeLeases, runtimeStatus } from "./runtime-leases.js";
import { readRuntimeSettings } from "./runtime-settings.js";
import { listThreads, listThreadsForPrincipal, updateThread } from "./threads.js";
import { containedUserPolicyPath, tenantIsolationBoundary, threadUsesContainedUserPolicy } from "./tenant-policy.js";
import { adminUserId, normalizeUserId } from "./users.js";
import { builtinUserSkillDefinitions, userScopedCapabilityHints } from "./user-skills.js";

function nowIso() {
  return new Date().toISOString();
}

function clean(value) {
  return String(value || "").trim();
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
    whatsappStatus: "curl \"$ORKESTR_API_BASE/api/connectors/whatsapp/status\"",
    connectorStatus: "curl \"$ORKESTR_API_BASE/api/setup/status\"",
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
  const host = env.ORKESTR_HOST || "127.0.0.1";
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
  const scoped = Boolean(principal && String(principal.role || "").toLowerCase() !== "admin");
  const containedPolicy = threadUsesContainedUserPolicy(thread || { ownerUserId: owner }, env);
  return {
    ok: Boolean(thread),
    matched: Boolean(thread),
    matchedBy: matchedBy || null,
    cwd,
    apiBase: apiBase(env),
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
      sanitizerRequired: true,
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
