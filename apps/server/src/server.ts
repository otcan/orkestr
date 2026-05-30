import "reflect-metadata";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { loadOverlayExecutorAdapters, recoverInterruptedExecutions } from "../../../packages/core/src/executors.js";
import {
  consumeThreadConnectorDeliverySignalCount,
  drainAllPendingThreadInputs,
  setThreadConnectorDeliverySignalHandler,
  setThreadInputDeliveryFailureHandler,
  syncPaneProgressForActiveLeases,
  syncRuntimeLeases,
} from "../../../packages/core/src/runtime-leases.js";
import { markDueTimers } from "../../../packages/core/src/timers.js";
import {
  recoverStaleCodexAppServerTurns,
  setCodexAppServerMessageHandler,
  stopCodexAppServerClients,
} from "../../../packages/core/src/codex-app-server.js";
import { deployDrainActiveSync } from "../../../packages/core/src/deploy-drain.js";
import { deliverWhatsAppReplies, syncWhatsAppTypingIndicators } from "../../../packages/connectors/src/whatsapp.js";
import {
  recoverConfiguredLocalWhatsAppAccounts,
  recoverUnreadLocalWhatsAppMessages,
  startConfiguredLocalWhatsAppAccounts,
  stopLocalWhatsAppBridge,
} from "../../../packages/connectors/src/whatsapp-local-bridge.js";
import { ensureDataDirs } from "../../../packages/storage/src/paths.js";
import { authorizeHttpRequest } from "../../../packages/core/src/security.js";
import { getThreadForPrincipal, listThreads } from "../../../packages/core/src/threads.js";
import { isAdminPrincipal } from "../../../packages/core/src/policy.js";
import { AppModule } from "./app.module.js";
import { JsonErrorFilter } from "./common/json-error.filter.js";
import { attachDesktopProxyUpgrade, registerDesktopProxy } from "./desktop-proxy.js";
import { registerStaticFallback } from "./static-fallback.js";
import { attachThreadStreamUpgrade } from "./thread-stream.js";

export async function createApp(): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, { logger: false });
  app.use((_request, response, next) => {
    response.setHeader("cache-control", "no-store");
    next();
  });
  app.use(async (request, response, next) => {
    try {
      const result = await authorizeHttpRequest(request);
      if (result.ok) {
        (request as any).orkestrPrincipal = result.principal;
        (request as any).orkestrSecuritySession = result.session || null;
        const resourceAuth = await authorizeThreadResourceRequest(request, result.principal);
        if (!resourceAuth.ok) {
          return response
            .status(resourceAuth.statusCode || 403)
            .type("application/json")
            .send(JSON.stringify({ ok: false, error: resourceAuth.error || "forbidden" }));
        }
        const connectorAuth = authorizeConnectorResourceRequest(request, result.principal);
        if (!connectorAuth.ok) {
          return response
            .status(connectorAuth.statusCode || 403)
            .type("application/json")
            .send(JSON.stringify({ ok: false, error: connectorAuth.error || "forbidden" }));
        }
        const controlPlaneAuth = authorizeControlPlaneRequest(request, result.principal);
        if (!controlPlaneAuth.ok) {
          return response
            .status(controlPlaneAuth.statusCode || 403)
            .type("application/json")
            .send(JSON.stringify({ ok: false, error: controlPlaneAuth.error || "forbidden" }));
        }
        return next();
      }
      return response
        .status(result.statusCode || 401)
        .type("application/json")
        .send(JSON.stringify({
          ok: false,
          error: result.error || "unauthorized",
          security: result.status,
        }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return response
        .status(500)
        .type("application/json")
        .send(JSON.stringify({ ok: false, error: message }));
    }
  });
  app.useGlobalFilters(new JsonErrorFilter());
  return app;
}

function authorizeConnectorResourceRequest(request: any, principal: any) {
  const route = connectorRouteFromApiRequest(request);
  if (!route) return { ok: true };
  if (isPublicConnectorRoute(route)) return { ok: true };
  if (isAdminPrincipal(principal)) return { ok: true };
  if (isUserConnectorRoute(route)) return { ok: true };
  return { ok: false, statusCode: 403, error: "connector_admin_required" };
}

function connectorRouteFromApiRequest(request: any) {
  const url = String(request?.originalUrl || request?.url || "").split("?")[0];
  const parts = url.split("/").filter(Boolean);
  if (parts[0] !== "api" || parts[1] !== "connectors") return null;
  return {
    method: String(request?.method || "GET").toUpperCase(),
    connector: String(parts[2] || "").trim().toLowerCase(),
    action: parts.slice(3).map((part) => String(part || "").trim().toLowerCase()),
  };
}

function isPublicConnectorRoute(route: { method: string; connector: string; action: string[] }) {
  return route.method === "POST" &&
    route.connector === "whatsapp" &&
    route.action.length === 1 &&
    route.action[0] === "inbound";
}

function isUserConnectorRoute(route: { method: string; connector: string; action: string[] }) {
  if (route.connector === "gmail") {
    if (route.method === "GET" && route.action.length === 2 && route.action[0] === "oauth" && route.action[1] === "start") return true;
    if (route.method === "GET" && route.action[0] === "messages" && route.action.length <= 2) return true;
    if (route.method === "POST" && route.action.length === 1 && route.action[0] === "test") return true;
  }
  if (route.connector === "outlook") {
    if (route.method === "POST" && route.action.length === 2 && route.action[0] === "oauth" && ["start", "poll"].includes(route.action[1])) return true;
    if (route.method === "POST" && route.action.length === 1 && route.action[0] === "test") return true;
  }
  return false;
}

function routePartsFromApiRequest(request: any) {
  const url = String(request?.originalUrl || request?.url || "").split("?")[0];
  return url.split("/").filter(Boolean).map((part) => {
    try {
      return decodeURIComponent(part).trim();
    } catch {
      return String(part || "").trim();
    }
  });
}

function authorizeControlPlaneRequest(request: any, principal: any) {
  if (isAdminPrincipal(principal)) return { ok: true };
  const method = String(request?.method || "GET").toUpperCase();
  const parts = routePartsFromApiRequest(request);
  if (parts[0] !== "api") return { ok: true };
  const [surface, second, third, fourth] = parts.slice(1).map((part) => part.toLowerCase());

  if (surface === "codex") return { ok: false, statusCode: 403, error: "control_plane_admin_required" };
  if (surface === "users") {
    if ((second === "me" && third === "skills") || third === "skills") return { ok: true };
    return { ok: false, statusCode: 403, error: "control_plane_admin_required" };
  }
  if (surface === "tenant-vms") return { ok: false, statusCode: 403, error: "control_plane_admin_required" };
  if (surface === "agents" || surface === "executors" || surface === "executions") {
    return { ok: false, statusCode: 403, error: "control_plane_admin_required" };
  }
  if (surface === "runtime-leases") return { ok: false, statusCode: 403, error: "control_plane_admin_required" };
  if (surface === "settings") return { ok: false, statusCode: 403, error: "control_plane_admin_required" };
  if (surface === "system" && !["workspace-folders", "files"].includes(second || "")) {
    return { ok: false, statusCode: 403, error: "control_plane_admin_required" };
  }
  if (surface === "setup" && second === "security") {
    const bootstrapChallenge =
      method === "POST" &&
      third &&
      ["challenge", "challenges"].includes(third) &&
      !fourth;
    const challengeStatus =
      method === "GET" &&
      third === "challenges" &&
      Boolean(fourth);
    const pair =
      method === "POST" &&
      third === "pair";
    const status =
      method === "GET" &&
      third === "status";
    if (bootstrapChallenge || challengeStatus || pair || status) return { ok: true };
    return { ok: false, statusCode: 403, error: "control_plane_admin_required" };
  }
  if (surface === "setup" && second === "backup") {
    return { ok: false, statusCode: 403, error: "control_plane_admin_required" };
  }
  return { ok: true };
}

async function authorizeThreadResourceRequest(request: any, principal: any) {
  const threadId = threadIdFromApiRequest(request);
  if (!threadId) return { ok: true };
  try {
    const ambiguity = await ambiguousThreadRoute(threadId);
    if (ambiguity) return { ok: false, statusCode: 409, error: "ambiguous_thread_name_use_id" };
    const thread = await getThreadForPrincipal(threadId, principal);
    if (!thread) return { ok: false, statusCode: 404, error: "thread_not_found" };
    return { ok: true };
  } catch (error: any) {
    return {
      ok: false,
      statusCode: error?.statusCode || 403,
      error: error?.message || "forbidden",
    };
  }
}

async function ambiguousThreadRoute(threadId: string) {
  const threads = await listThreads().catch(() => []);
  const matches = threads.filter((thread: any) => thread.id === threadId || thread.name === threadId || thread.bindingName === threadId);
  if (matches.length < 2) return false;
  return !matches.some((thread: any) => thread.id === threadId);
}

function threadIdFromApiRequest(request: any) {
  const url = String(request?.originalUrl || request?.url || "").split("?")[0];
  const parts = url.split("/").filter(Boolean);
  if (parts[0] !== "api" || parts[1] !== "threads") return "";
  let id = "";
  try {
    id = parts[2] ? decodeURIComponent(parts[2]) : "";
  } catch {
    id = parts[2] || "";
  }
  if (!id || id === "summary") return "";
  return id;
}

export async function startServer({ port = 19812, host = "127.0.0.1", openBrowser = false } = {}) {
  const serverEnv = { ...process.env };
  await ensureDataDirs(serverEnv);
  if (serverEnv.ORKESTR_RECOVER_RUNNING_ON_START !== "0") {
    await recoverInterruptedExecutions(serverEnv);
  }
  await loadOverlayExecutorAdapters(serverEnv);
  await startConfiguredLocalWhatsAppAccounts(serverEnv).catch(() => {});
  const app = await createApp();

  const timer = setInterval(() => {
    runTimerLoop(serverEnv).catch(() => {});
  }, timerLoopIntervalMs());

  const runtimeMonitor = setInterval(() => {
    syncRuntimeAndDeliverWhatsApp(serverEnv).catch(() => {});
  }, runtimeMonitorIntervalMs());

  const paneProgressMonitor = setInterval(() => {
    syncPaneProgressForActiveLeases(serverEnv).catch(() => {});
  }, paneProgressMonitorIntervalMs());
  const whatsappDeliveryScheduler = createWhatsAppDeliveryScheduler(serverEnv);
  const clearConnectorDeliverySignalHandler = setThreadConnectorDeliverySignalHandler(() => {
    whatsappDeliveryScheduler.schedule();
  });
  const clearDeliveryFailureHandler = setThreadInputDeliveryFailureHandler(() => {
    whatsappDeliveryScheduler.schedule();
  });
  const clearCodexAppServerMessageHandler = setCodexAppServerMessageHandler(({ message }: any = {}) => {
    if (String(message?.connector || "").trim().toLowerCase() === "whatsapp") {
      whatsappDeliveryScheduler.schedule();
    }
  });

  registerDesktopProxy(app);
  registerStaticFallback(app);
  await app.init();
  attachDesktopProxyUpgrade(app.getHttpServer());
  attachThreadStreamUpgrade(app.getHttpServer());
  await app.listen(port, host);
  whatsappDeliveryScheduler.schedule();
  const startupRecoveryTimer = scheduleStartupRecovery(serverEnv);

  const url = `http://${host}:${port}`;
  console.log(`Orkestr setup wizard: ${url}`);
  if (openBrowser) {
    execFile("xdg-open", [url], { timeout: 1000 }, () => {});
  }

  return serverHandle(app, timer, runtimeMonitor, paneProgressMonitor, async () => {
    clearConnectorDeliverySignalHandler();
    clearDeliveryFailureHandler();
    clearCodexAppServerMessageHandler();
    if (startupRecoveryTimer) clearTimeout(startupRecoveryTimer);
    whatsappDeliveryScheduler.close();
    stopCodexAppServerClients();
    await stopLocalWhatsAppBridge(serverEnv).catch(() => {});
  });
}

export function runtimeMonitorIntervalMs() {
  const parsed = Number(process.env.ORKESTR_RUNTIME_MONITOR_INTERVAL_MS || 5000);
  return Number.isFinite(parsed) ? Math.max(5000, parsed) : 5000;
}

export function paneProgressMonitorIntervalMs() {
  const parsed = Number(process.env.ORKESTR_PANE_PROGRESS_INTERVAL_MS || 1000);
  return Number.isFinite(parsed) ? Math.max(1000, parsed) : 1000;
}

function timerLoopIntervalMs() {
  const parsed = Number(process.env.ORKESTR_TIMER_LOOP_INTERVAL_MS || 30_000);
  return Number.isFinite(parsed) ? Math.max(5000, parsed) : 30_000;
}

export function startupRecoveryDelayMs() {
  const parsed = Number(process.env.ORKESTR_STARTUP_RECOVERY_DELAY_MS || 1000);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 1000;
}

function scheduleStartupRecovery(env = process.env) {
  if (env.ORKESTR_STARTUP_RECOVERY === "0") return null;
  const timer = setTimeout(() => {
    recoverAfterStartup(env).catch(() => {});
  }, startupRecoveryDelayMs());
  timer.unref?.();
  return timer;
}

export async function recoverAfterStartup(env = process.env) {
  if (deployDrainActiveSync(env)) {
    return { deferred: true, reason: "deploy_draining" };
  }
  await drainAllPendingThreadInputs(env).catch(() => []);
  return syncRuntimeAndDeliverWhatsApp(env, { forceWhatsapp: true, recoveryCause: "orkestr_restart" });
}

async function runTimerLoop(env = process.env) {
  const dueTimers = await markDueTimers(env);
  const drained = await drainAllPendingThreadInputs(env);
  const deliveredCount = drained.reduce((count: number, result: any) => count + Number(result?.delivered?.length || 0), 0);
  if (dueTimers.length || deliveredCount > 0 || drained.length > 0) {
    await syncRuntimeAndDeliverWhatsApp(env, { forceWhatsapp: true });
  }
}

async function syncRuntimeAndDeliverWhatsApp(env = process.env, options: { forceWhatsapp?: boolean; recoveryCause?: string } = {}) {
  const pendingConnectorDeliveries = consumeThreadConnectorDeliverySignalCount();
  const synced = await syncRuntimeLeases(env);
  const recovered = await recoverStaleCodexAppServerTurns(env, { noticeCause: options.recoveryCause }).catch(() => ({ recovered: 0, appended: 0 }));
  await recoverConfiguredLocalWhatsAppAccounts(env).catch(() => {});
  const unreadRecovery = await recoverUnreadLocalWhatsAppMessages(env).catch(() => ({ routed: 0 }));
  await syncWhatsAppTypingIndicators(env).catch(() => {});
  const connectorDeliveries = pendingConnectorDeliveries + consumeThreadConnectorDeliverySignalCount();
  const appended = (synced.appended || 0) + (recovered.appended || 0);
  if (options.forceWhatsapp || appended > 0 || connectorDeliveries > 0 || Number(unreadRecovery.routed || 0) > 0) {
    await deliverWhatsAppReplies(env).catch(() => {});
  }
  return { ...synced, appended, recoveredAppServerTurns: recovered.recovered || 0 };
}

function createWhatsAppDeliveryScheduler(env = process.env) {
  let timer: NodeJS.Timeout | null = null;
  const retryDelayMs = whatsAppDeliveryRetryDelayMs();
  const shouldRetry = (result: any) => {
    if (!result || !Array.isArray(result.failed) || !result.failed.length) return false;
    return result.failed.some((failure: any) => {
      const reason = String(failure?.error || failure?.reason || failure?.message || "").toLowerCase();
      return reason.includes("not_ready") ||
        reason.includes("bridge_not_ready") ||
        reason.includes("fetch failed") ||
        reason.includes("econnrefused") ||
        reason.includes("timeout");
    });
  };
  const run = () => {
    syncWhatsAppTypingIndicators(env)
      .catch(() => {})
      .then(() => deliverWhatsAppReplies(env))
      .then(async (result) => {
        await syncWhatsAppTypingIndicators(env).catch(() => {});
        return result;
      })
      .then((result) => {
        if (shouldRetry(result)) {
          scheduler.schedule(retryDelayMs);
        }
      })
      .catch(() => {
        scheduler.schedule(retryDelayMs);
      });
  };
  const scheduler = {
    schedule(delayMs = 0) {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        run();
      }, Math.max(0, delayMs));
      if (typeof timer.unref === "function") timer.unref();
    },
    close() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
  return scheduler;
}

function whatsAppDeliveryRetryDelayMs() {
  const parsed = Number(process.env.ORKESTR_WHATSAPP_DELIVERY_RETRY_MS || 10_000);
  return Number.isFinite(parsed) ? Math.max(1000, parsed) : 10_000;
}

export function serverHandle(
  app: INestApplication,
  timer?: NodeJS.Timeout,
  runtimeMonitor?: NodeJS.Timeout,
  paneProgressMonitor?: NodeJS.Timeout,
  cleanup?: () => void | Promise<void>,
) {
  return {
    address: () => app.getHttpServer().address(),
    close: (callback?: (error?: Error) => void) => {
      if (timer) clearInterval(timer);
      if (runtimeMonitor) clearInterval(runtimeMonitor);
      if (paneProgressMonitor) clearInterval(paneProgressMonitor);
      const httpServer = app.getHttpServer();
      Promise.resolve(cleanup?.())
        .then(() => {
          httpServer.closeIdleConnections?.();
          httpServer.closeAllConnections?.();
        })
        .then(() => app.close())
        .then(() => {
          httpServer.closeIdleConnections?.();
          httpServer.closeAllConnections?.();
        })
        .then(() => callback?.())
        .catch((error) => callback?.(error));
    },
  };
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || "")) {
  const args = new Set(process.argv.slice(2));
  const port = Number(process.env.PORT || process.env.ORKESTR_PORT || 19812);
  const host = process.env.ORKESTR_HOST || "127.0.0.1";
  startServer({ port, host, openBrowser: args.has("--open") }).catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  });
}
