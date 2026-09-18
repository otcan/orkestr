import { createHash } from "node:crypto";
import { readVirtualBrowserTarget } from "../../../packages/browsers/src/browsers.js";
import { assertDesktopAccess } from "../../../packages/core/src/desktop-access.js";
import { desktopCapabilityRequired } from "../../../packages/browsers/src/desktop-capability-broker.js";
import { validateDesktopShareSession } from "../../../packages/core/src/desktop-shares.js";
import { observeHistogram, incrementCounter } from "../../../packages/core/src/observability.js";

function failure(message: string, statusCode = 503): Error {
  return Object.assign(new Error(message), { statusCode });
}

export function desktopProxyTimeout(env = process.env, name = "ORKESTR_DESKTOP_PROXY_LOOKUP_TIMEOUT_MS", fallback = 6000): number {
  const value = Number(env[name] || fallback);
  return Number.isFinite(value) ? Math.max(100, Math.min(30_000, value)) : fallback;
}

export async function desktopPhase<T>(phase: string, operation: () => Promise<T>): Promise<T> {
  const start = performance.now();
  let outcome = "ok";
  try { return await operation(); }
  catch (error) { outcome = "error"; throw error; }
  finally {
    observeHistogram("orkestr_desktop_proxy_phase_seconds", (performance.now() - start) / 1000, { phase, outcome });
  }
}

function portFromEndpoint(value: unknown): number {
  // Preserve legacy host:port and explicit default-port URLs. URL.port alone
  // drops :80/:443 and does not accept bare host:port provider records.
  const match = String(value || "").trim().match(/(?::|:\/\/[^/:]+:)(\d{2,5})(?:\/|$)/);
  return Number(match?.[1] || 0);
}

export function desktopSessionPort(session: any): number {
  const value = Number(session?.web_port || session?.webPort || session?.novnc_port || session?.noVncPort || portFromEndpoint(session?.upstream));
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw failure("desktop_not_running", 409);
  return value;
}

function bindingKey(slug: string, principal: any, scope: any, decision: any, env: any): string {
  // This key partitions routing work, not authorization. No identity is emitted
  // as a metric label; tokens are hashed rather than retained in map keys.
  return createHash("sha256").update(JSON.stringify([
    env.ORKESTR_HOME, env.ORKESTR_INSTANCE_ID, env.ORKESTR_TENANT_VM_ID,
    env.ORKESTR_BROWSER_API_URL, env.ORKESTR_BROWSER_SESSIONS_URL, env.ORKESTR_BROWSERCTL_PATH,
    principal?.kind, principal?.userId, principal?.role, slug, scope.threadId,
    decision.ownerUserId, decision.boundaryId, decision.resourceId,
    decision.policyRevision, decision.grantRevision, decision.resourceGeneration,
    scope.desktopShare?.id, scope.desktopShare?.shareGeneration, scope.shareAttemptId,
    scope.fencingToken,
  ])).digest("hex");
}

// Only unfinished lookups are shared. No completed port or authorization cache:
// the next wave sees a fresh runtime record, including restart/port changes.
export function createDesktopTargetResolver(deps: any = {}) {
  const authorize = deps.authorize || assertDesktopAccess;
  const readTarget = deps.readTarget || readVirtualBrowserTarget;
  const requireCapability = deps.requireCapability || desktopCapabilityRequired;
  const validateShare = deps.validateShare || validateDesktopShareSession;
  const inFlight = new Map<string, Promise<number>>();
  const maxPending = Math.max(1, Math.min(256, Number(deps.maxPending) || 64));

  return async (slug: string, principal: any, scope: any = {}, env = process.env): Promise<number> => {
    if (requireCapability(env, { threadId: scope.threadId, desktopSlug: slug }) && !scope.desktopShare) {
      throw failure("desktop_brokered_share_required", 403);
    }
    const access = () => desktopPhase("authorization", () => authorize({
      principal, threadId: scope.threadId, desktopSlug: slug,
      permission: scope.desktopShare ? "share" : "operate",
    }, env));
    const decision: any = await access();
    if (scope.grantRevision && decision.grantRevision !== scope.grantRevision) throw failure("desktop_share_grant_changed", 401);
    const key = bindingKey(slug, principal, scope, decision, env);
    let pending = inFlight.get(key);
    if (!pending) {
      if (inFlight.size >= maxPending) throw failure("desktop_lookup_busy");
      const controller = new AbortController();
      let timer: NodeJS.Timeout;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(failure("desktop_lookup_timeout"));
          controller.abort();
        }, desktopProxyTimeout(env));
        timer.unref();
      });
      pending = desktopPhase("target_lookup", () => Promise.race([
        Promise.resolve().then(() => readTarget(slug, env, {
          principal, threadId: scope.threadId, ownerUserId: decision.ownerUserId,
          fencingToken: scope.fencingToken || "", signal: controller.signal,
        })).then(desktopSessionPort), deadline,
      ])).finally(() => {
        clearTimeout(timer);
        inFlight.delete(key);
      });
      inFlight.set(key, pending);
      incrementCounter("orkestr_desktop_proxy_lookup_total", { outcome: "started" });
    } else incrementCounter("orkestr_desktop_proxy_lookup_total", { outcome: "shared" });
    // A disconnected waiter cannot cancel another request's shared lookup.
    const port = await pending;
    const current: any = await access();
    if (bindingKey(slug, principal, scope, current, env) !== key) throw failure("desktop_target_binding_changed", 409);
    if (scope.desktopShare) {
      await validateShare({ shareId: scope.desktopShare.id, attemptId: scope.shareAttemptId || "", env });
    }
    return port;
  };
}

export const resolveDesktopTarget = createDesktopTargetResolver();
