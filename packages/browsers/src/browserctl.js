import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { userDataPaths } from "../../storage/src/paths.js";
import { isAdminPrincipal } from "../../core/src/policy.js";
import { normalizeUserId } from "../../core/src/users.js";
import { activeDesktopLeaseStatus, attachDesktopStateToSessions } from "./desktop-leases.js";

const execFileAsync = promisify(execFile);

function browserctlCommand(env = process.env) {
  return String(env.ORKESTR_BROWSERCTL_PATH || env.ORKESTR_BROWSERCTL || "browserctl").trim();
}

function browserApiBase(env = process.env) {
  return String(env.ORKESTR_BROWSER_API_URL || "").trim().replace(/\/+$/, "");
}

function browserSessionsUrl(env = process.env) {
  return String(env.ORKESTR_BROWSER_SESSIONS_URL || "").trim();
}

function numberEnv(env, name, fallback) {
  const parsed = Number(env[name] || fallback);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function stableHash(text) {
  let hash = 0;
  for (const char of String(text || "")) {
    hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  }
  return Math.abs(hash);
}

function browserctlScope(env = process.env, options = {}) {
  const principal = options?.principal || null;
  const personal = Boolean(principal?.userId && !isAdminPrincipal(principal));
  const ownerUserId = normalizeUserId(
    personal
      ? principal.userId
      : options?.ownerUserId || env.ORKESTR_ADMIN_USER_ID || "admin",
  );
  return {
    ownerUserId,
    personal,
    scope: personal ? "user" : "admin",
    scopeLabel: personal ? "Private user desktop" : "Local admin desktop",
    home: personal ? userDataPaths(ownerUserId, env).root : env.ORKESTR_HOME,
    portOffset: personal ? (stableHash(ownerUserId) % 1000) * 16 : 0,
  };
}

function scopedBrowserctlEnv(env = process.env, options = {}) {
  const scope = browserctlScope(env, options);
  if (!scope.personal) return { ...env, ORKESTR_BROWSER_OWNER_USER_ID: scope.ownerUserId };
  return {
    ...env,
    ORKESTR_HOME: scope.home,
    ORKESTR_BROWSER_OWNER_USER_ID: scope.ownerUserId,
    ORKESTR_BROWSER_SCOPE: scope.scope,
    ORKESTR_BROWSER_DEBUG_PORT_BASE: String(numberEnv(env, "ORKESTR_BROWSER_DEBUG_PORT_BASE", 9222) + scope.portOffset),
    ORKESTR_DESKTOP_WEB_PORT_BASE: String(numberEnv(env, "ORKESTR_DESKTOP_WEB_PORT_BASE", 6080) + scope.portOffset),
    ORKESTR_DESKTOP_VNC_PORT_BASE: String(numberEnv(env, "ORKESTR_DESKTOP_VNC_PORT_BASE", 5901) + scope.portOffset),
    ORKESTR_DESKTOP_DISPLAY_BASE: String(numberEnv(env, "ORKESTR_DESKTOP_DISPLAY_BASE", 90) + scope.portOffset),
  };
}

function tagSessionScope(session, env = process.env, options = {}) {
  const scope = browserctlScope(env, options);
  return {
    ...session,
    ownerUserId: session.ownerUserId || session.owner_user_id || scope.ownerUserId,
    scope: session.scope || scope.scope,
    scopeLabel: session.scopeLabel || scope.scopeLabel,
    personal: session.personal ?? scope.personal,
  };
}

async function fetchBrowserJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const error = new Error(body || `browser API returned ${response.status}`);
    error.statusCode = response.status;
    throw error;
  }
  return response.json();
}

function openUrlError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeOpenUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) throw openUrlError("browser_open_url_required", 400);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw openUrlError("browser_open_url_invalid", 400);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) throw openUrlError("browser_open_url_unsupported_protocol", 400);
  return parsed.href;
}

async function runBrowserctl(args, env = process.env) {
  const command = browserctlCommand(env);
  try {
    const result = await execFileAsync(command, args, {
      env: { ...process.env, ...env },
      timeout: Number(env.ORKESTR_BROWSERCTL_TIMEOUT_MS || 45_000),
      maxBuffer: 5 * 1024 * 1024,
    });
    return result.stdout ? JSON.parse(result.stdout) : { ok: true };
  } catch (error) {
    const detail = String(error?.stderr || error?.stdout || error?.message || "browserctl failed").trim();
    const wrapped = new Error(detail);
    wrapped.statusCode = error?.code === "ENOENT" ? 503 : 400;
    wrapped.cause = error;
    throw wrapped;
  }
}

function normalizeBrowserctlSession(session) {
  const slug = String(session?.slug || session?.id || "").trim();
  return {
    ...session,
    id: slug,
    slug,
    label: String(session?.label || slug || "Desktop").trim(),
    type: String(session?.type || "desktop").trim(),
    access: String(session?.access || (session?.desk_url || session?.url ? "desk" : session?.cdp_url ? "cdp" : "internal")).trim(),
    status: String(session?.status || session?.state || "unknown").trim(),
    state: String(session?.state || session?.status || "unknown").trim(),
    profile_path: session?.profile_path || session?.profileDir || session?.profile || null,
    profileDir: session?.profileDir || session?.profile_path || session?.profile || null,
    control: session?.control && typeof session.control === "object" && !Array.isArray(session.control)
      ? session.control
      : { health: true },
    source: "browserctl",
  };
}

async function attachDesktopLeases(sessions, env = process.env, options = {}) {
  return attachDesktopStateToSessions(sessions.map((session) => tagSessionScope(session, env, options)), env, options);
}

async function attachDesktopLease(session, env = process.env, options = {}) {
  const scoped = tagSessionScope(session, env, options);
  const lease = await activeDesktopLeaseStatus(scoped.slug, env, { principal: options?.principal, ownerUserId: scoped.ownerUserId }).catch(() => null);
  const [decorated] = await attachDesktopStateToSessions([{
    ...scoped,
    lease,
    leased: !!lease,
    leaseOwnerThreadId: lease?.threadId || null,
    leaseOwnerLabel: lease?.ownerThreadLabel || null,
  }], env, options);
  return decorated || scoped;
}

async function listRemoteDesktopSessions(env = process.env, options = {}) {
  const explicitUrl = browserSessionsUrl(env);
  const base = browserApiBase(env);
  if (!explicitUrl && !base) return null;
  const payload = await fetchBrowserJson(explicitUrl || `${base}/api/browser-sessions`);
  const sessions = Array.isArray(payload?.sessions) ? payload.sessions.map(normalizeBrowserctlSession) : [];
  return {
    ...payload,
    ok: payload?.ok !== false,
    source: payload?.source || "remote-browser-api",
    sessions: await attachDesktopLeases(sessions, env, options),
  };
}

async function remoteDesktopAction(slug, action, env = process.env, options = {}) {
  const base = browserApiBase(env);
  if (!base) return null;
  const normalized = action === "open" ? "start" : action === "prepare" ? "health" : action;
  const payload = await fetchBrowserJson(`${base}/api/browser-sessions/${encodeURIComponent(slug)}/${encodeURIComponent(normalized)}`, {
    method: "POST",
    body: "{}",
  });
  const session = payload?.browser || payload?.session || payload?.desktop || null;
  if (session) return { ...(await attachDesktopLease(normalizeBrowserctlSession(session), env, options)), action: normalized, ok: payload?.ok !== false };
  const listed = await listRemoteDesktopSessions(env, options);
  return listed?.sessions?.find((item) => item.slug === slug) || null;
}

async function remoteDesktopOpenUrl(slug, targetUrl, env = process.env, options = {}) {
  const base = browserApiBase(env);
  if (!base) return null;
  const payload = await fetchBrowserJson(`${base}/api/browser-sessions/${encodeURIComponent(slug)}/open-url`, {
    method: "POST",
    body: JSON.stringify({ url: targetUrl }),
  });
  const session = payload?.browser || payload?.session || payload?.desktop || null;
  if (session) {
    return {
      ...(await attachDesktopLease(normalizeBrowserctlSession(session), env, options)),
      action: "open-url",
      openedUrl: payload?.openedUrl || targetUrl,
      ok: payload?.ok !== false,
    };
  }
  return { ok: payload?.ok !== false, action: "open-url", openedUrl: payload?.openedUrl || targetUrl };
}

async function openCdpPage(cdpUrl, targetUrl) {
  const base = String(cdpUrl || "").trim().replace(/\/+$/, "");
  if (!base) throw openUrlError("browser_cdp_url_required", 409);
  const endpoint = `${base}/json/new?${encodeURIComponent(targetUrl)}`;
  let response = await fetch(endpoint, { method: "PUT" });
  if (response.status === 404 || response.status === 405) response = await fetch(endpoint);
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw openUrlError(body || `browser CDP returned ${response.status}`, response.status || 502);
  }
  return response.json().catch(() => ({}));
}

export function isBrowserctlUnavailableError(error) {
  return Number(error?.statusCode || 0) === 503;
}

export async function listManagedDesktopSessions(env = process.env, options = {}) {
  const remote = await listRemoteDesktopSessions(env, options);
  if (remote) return remote;
  const payload = await runBrowserctl(["list", "--json"], scopedBrowserctlEnv(env, options));
  const sessions = Array.isArray(payload?.sessions) ? payload.sessions.map(normalizeBrowserctlSession) : [];
  return {
    ...payload,
    ok: payload?.ok !== false,
    source: "browserctl",
    sessions: await attachDesktopLeases(sessions, env, options),
  };
}

export async function managedDesktopAction(slug, action, env = process.env, options = {}) {
  const normalized = action === "open" ? "start" : action === "prepare" ? "health" : action;
  const remote = await remoteDesktopAction(slug, normalized, env, options);
  if (remote) return remote;
  const args = [normalized, slug];
  if (normalized === "cleanup") args.push("--safe");
  const payload = await runBrowserctl(args, scopedBrowserctlEnv(env, options));
  const session = payload?.session
    ? normalizeBrowserctlSession(payload.session)
    : (await listManagedDesktopSessions(env, options)).sessions.find((item) => item.slug === slug);
  if (!session) {
    const error = new Error("browser_session_not_found");
    error.statusCode = 404;
    throw error;
  }
  return { ...(await attachDesktopLease(session, env, options)), action: normalized, ok: payload?.ok !== false };
}

export async function managedDesktopOpenUrl(slug, url, env = process.env, options = {}) {
  const targetUrl = normalizeOpenUrl(url);
  const remote = await remoteDesktopOpenUrl(slug, targetUrl, env, options);
  if (remote) return remote;
  const session = await managedDesktopAction(slug, "start", env, options);
  const cdpUrl = String(session?.cdp_url || "").trim();
  if (!cdpUrl) throw openUrlError("browser_cdp_url_required", 409);
  const page = await openCdpPage(cdpUrl, targetUrl);
  return {
    ...session,
    action: "open-url",
    openedUrl: targetUrl,
    cdpPage: {
      id: page?.id || null,
      type: page?.type || null,
      title: page?.title || null,
      url: page?.url || targetUrl,
    },
    ok: true,
  };
}
