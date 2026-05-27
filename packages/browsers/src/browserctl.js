import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { activeDesktopLeaseStatus, publicDesktopLeases } from "./desktop-leases.js";

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

async function attachDesktopLeases(sessions, env = process.env) {
  const leases = await publicDesktopLeases({}, env).catch(() => []);
  const leaseBySlug = new Map(leases.map((lease) => [lease.desktopSlug, lease]));
  return sessions.map((session) => {
    const lease = leaseBySlug.get(String(session.slug || "")) || null;
    return {
      ...session,
      lease,
      leased: !!lease,
      leaseOwnerThreadId: lease?.threadId || null,
      leaseOwnerLabel: lease?.ownerThreadLabel || null,
    };
  });
}

async function attachDesktopLease(session, env = process.env) {
  const lease = await activeDesktopLeaseStatus(session.slug, env).catch(() => null);
  return {
    ...session,
    lease,
    leased: !!lease,
    leaseOwnerThreadId: lease?.threadId || null,
    leaseOwnerLabel: lease?.ownerThreadLabel || null,
  };
}

async function listRemoteDesktopSessions(env = process.env) {
  const explicitUrl = browserSessionsUrl(env);
  const base = browserApiBase(env);
  if (!explicitUrl && !base) return null;
  const payload = await fetchBrowserJson(explicitUrl || `${base}/api/browser-sessions`);
  const sessions = Array.isArray(payload?.sessions) ? payload.sessions.map(normalizeBrowserctlSession) : [];
  return {
    ...payload,
    ok: payload?.ok !== false,
    source: payload?.source || "remote-browser-api",
    sessions: await attachDesktopLeases(sessions, env),
  };
}

async function remoteDesktopAction(slug, action, env = process.env) {
  const base = browserApiBase(env);
  if (!base) return null;
  const normalized = action === "open" ? "start" : action === "prepare" ? "health" : action;
  const payload = await fetchBrowserJson(`${base}/api/browser-sessions/${encodeURIComponent(slug)}/${encodeURIComponent(normalized)}`, {
    method: "POST",
    body: "{}",
  });
  const session = payload?.browser || payload?.session || payload?.desktop || null;
  if (session) return { ...(await attachDesktopLease(normalizeBrowserctlSession(session), env)), action: normalized, ok: payload?.ok !== false };
  const listed = await listRemoteDesktopSessions(env);
  return listed?.sessions?.find((item) => item.slug === slug) || null;
}

async function remoteDesktopOpenUrl(slug, targetUrl, env = process.env) {
  const base = browserApiBase(env);
  if (!base) return null;
  const payload = await fetchBrowserJson(`${base}/api/browser-sessions/${encodeURIComponent(slug)}/open-url`, {
    method: "POST",
    body: JSON.stringify({ url: targetUrl }),
  });
  const session = payload?.browser || payload?.session || payload?.desktop || null;
  if (session) {
    return {
      ...(await attachDesktopLease(normalizeBrowserctlSession(session), env)),
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

export async function listManagedDesktopSessions(env = process.env) {
  const remote = await listRemoteDesktopSessions(env);
  if (remote) return remote;
  const payload = await runBrowserctl(["list", "--json"], env);
  const sessions = Array.isArray(payload?.sessions) ? payload.sessions.map(normalizeBrowserctlSession) : [];
  return {
    ...payload,
    ok: payload?.ok !== false,
    source: "browserctl",
    sessions: await attachDesktopLeases(sessions, env),
  };
}

export async function managedDesktopAction(slug, action, env = process.env) {
  const normalized = action === "open" ? "start" : action === "prepare" ? "health" : action;
  const remote = await remoteDesktopAction(slug, normalized, env);
  if (remote) return remote;
  const args = [normalized, slug];
  if (normalized === "cleanup") args.push("--safe");
  const payload = await runBrowserctl(args, env);
  const session = payload?.session
    ? normalizeBrowserctlSession(payload.session)
    : (await listManagedDesktopSessions(env)).sessions.find((item) => item.slug === slug);
  if (!session) {
    const error = new Error("browser_session_not_found");
    error.statusCode = 404;
    throw error;
  }
  return { ...(await attachDesktopLease(session, env)), action: normalized, ok: payload?.ok !== false };
}

export async function managedDesktopOpenUrl(slug, url, env = process.env) {
  const targetUrl = normalizeOpenUrl(url);
  const remote = await remoteDesktopOpenUrl(slug, targetUrl, env);
  if (remote) return remote;
  const session = await managedDesktopAction(slug, "start", env);
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
