import "reflect-metadata";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { loadOverlayExecutorAdapters, recoverInterruptedExecutions } from "../../../packages/core/src/executors.js";
import {
  setThreadConnectorDeliverySignalHandler,
  setThreadInputDeliveryFailureHandler,
  syncPaneProgressForActiveLeases,
} from "../../../packages/core/src/runtime-leases.js";
import {
  setCodexAppServerMessageHandler,
  stopCodexAppServerClients,
} from "../../../packages/core/src/codex-app-server.js";
import {
  startConfiguredLocalWhatsAppAccounts,
  stopLocalWhatsAppBridge,
} from "../../../packages/connectors/src/whatsapp-local-bridge.js";
import { clearWhatsAppDeliveryIdleCache } from "../../../packages/connectors/src/whatsapp.js";
import {
  createConnectorRuntimeSyncSignalHandler,
  whatsAppDeliveryFollowUpDelayMs,
} from "../../../packages/connectors/src/whatsapp-sync-signal.js";
import { ensureDataDirs } from "../../../packages/storage/src/paths.js";
import { authorizeHttpRequest } from "../../../packages/core/src/security.js";
import { getThreadForPrincipal, listThreads } from "../../../packages/core/src/threads.js";
import { isAdminPrincipal } from "../../../packages/core/src/policy.js";
import { AppModule } from "./app.module.js";
import { attachBrokerInstanceAppProxyUpgrade, registerBrokerInstanceAppProxy } from "./broker-instance-app-proxy.js";
import { JsonErrorFilter } from "./common/json-error.filter.js";
import { attachDesktopProxyUpgrade, registerDesktopProxy } from "./desktop-proxy.js";
import { attachTenantVmDesktopProxyUpgrade, registerTenantVmDesktopProxy } from "./tenant-vm-desktop-proxy.js";
import { registerStaticFallback } from "./static-fallback.js";
import { attachThreadStreamUpgrade } from "./thread-stream.js";
import { reportServerError } from "./watcher-reporting.js";
import {
  createRuntimeWhatsAppSyncRunner,
  createWhatsAppDeliveryScheduler,
  paneProgressMonitorIntervalMs,
  recoverAfterStartup,
  runtimeMonitorIntervalMs,
  runTimerLoop,
  scheduleStartupRecovery,
  startupRecoveryDelayMs,
  timerLoopIntervalMs,
} from "./server-runtime-sync.js";
import { recordServerShutdown } from "./server-lifecycle.js";

export {
  paneProgressMonitorIntervalMs,
  recoverAfterStartup,
  runtimeMonitorIntervalMs,
  startupRecoveryDelayMs,
};

function whatsappDeliveryPollIntervalMs(env = process.env) {
  const parsed = Number(env.ORKESTR_WHATSAPP_DELIVERY_POLL_INTERVAL_MS || 10000);
  return Number.isFinite(parsed) ? Math.max(5000, Math.floor(parsed)) : 10000;
}

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
        (request as any).orkestrMachineAuth = (result as any).machineAuth || null;
        (request as any).orkestrMachineAuthContext = (result as any).machineAuthContext || null;
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
      const authResult = result as any;
      const payload: Record<string, unknown> = {
        ok: false,
        error: result.error || "unauthorized",
        security: result.status,
      };
      if (authResult.machineAuth) payload.machineAuth = authResult.machineAuth;
      if (authResult.routingFailure) payload.routingFailure = authResult.routingFailure;
      return response
        .status(result.statusCode || 401)
        .type("application/json")
        .send(JSON.stringify(payload));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reportServerError(process.env, {
        source: "server.http.auth",
        code: "http_auth_unhandled",
        message,
        error,
        method: String((request as any)?.method || ""),
        route: String((request as any)?.originalUrl || (request as any)?.url || ""),
      });
      return response
        .status(500)
        .type("application/json")
        .send(JSON.stringify({ ok: false, error: message }));
    }
  });
  app.useGlobalFilters(new JsonErrorFilter(({ exception, statusCode, message, request }) => {
    reportServerError(process.env, {
      source: "server.http.exception",
      code: "http_exception_unhandled",
      message,
      error: exception,
      method: String((request as any)?.method || ""),
      route: String((request as any)?.originalUrl || (request as any)?.url || ""),
      statusCode,
    });
  }));
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
  if (route.connector === "whatsapp") {
    if (route.action[0] !== "accounts") return false;
    if (route.method === "GET" && route.action.length === 1) return true;
    if (route.method === "POST" && route.action.length === 1) return true;
    if ((route.method === "PUT" || route.method === "DELETE") && route.action.length === 2) return true;
    if (route.method === "GET" && route.action.length === 3 && ["status", "qr.svg"].includes(route.action[2])) return true;
    if (route.method === "POST" && route.action.length === 3 && ["pairing-session", "reconnect", "disconnect"].includes(route.action[2])) return true;
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
    if (second === "me" && (!third || ["skills", "credit-usage", "support", "onboarding"].includes(third))) return { ok: true };
    if (third === "skills" || third === "credit-usage" || third === "onboarding") return { ok: true };
    return { ok: false, statusCode: 403, error: "control_plane_admin_required" };
  }
  if (surface === "tenant-vms" || surface === "tenant-slices") return { ok: false, statusCode: 403, error: "control_plane_admin_required" };
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
  if (surface === "setup" && second === "demo-preferences") return { ok: true };
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
  await startConfiguredLocalWhatsAppAccounts(serverEnv).catch((error) => {
    reportServerError(serverEnv, {
      source: "server.start.whatsapp",
      code: "whatsapp_start_failed",
      message: error?.message || String(error),
      error,
    });
  });
  const app = await createApp();
  const runRuntimeSync = createRuntimeWhatsAppSyncRunner(serverEnv);

  const timer = setInterval(() => {
    runTimerLoop(serverEnv, runRuntimeSync).catch((error) => {
      reportServerError(serverEnv, {
        source: "server.timerLoop",
        code: "timer_loop_failed",
        message: error?.message || String(error),
        error,
      });
    });
  }, timerLoopIntervalMs());

  const runtimeMonitor = setInterval(() => {
    runRuntimeSync().catch((error) => {
      reportServerError(serverEnv, {
        source: "server.runtimeMonitor",
        code: "runtime_monitor_failed",
        message: error?.message || String(error),
        error,
      });
    });
  }, runtimeMonitorIntervalMs());

  const paneProgressMonitor = setInterval(() => {
    syncPaneProgressForActiveLeases(serverEnv).catch((error) => {
      reportServerError(serverEnv, {
        source: "server.paneProgress",
        code: "pane_progress_sync_failed",
        message: error?.message || String(error),
        error,
      });
    });
  }, paneProgressMonitorIntervalMs());
  const whatsappDeliveryScheduler = createWhatsAppDeliveryScheduler(serverEnv);
  const whatsappDeliveryPoll = setInterval(() => {
    whatsappDeliveryScheduler.schedule();
  }, whatsappDeliveryPollIntervalMs(serverEnv));
  whatsappDeliveryPoll.unref?.();
  const scheduleWhatsAppDeliveryFollowUp = () => {
    clearWhatsAppDeliveryIdleCache();
    const timer = setTimeout(() => whatsappDeliveryScheduler.schedule(), whatsAppDeliveryFollowUpDelayMs(serverEnv));
    if (typeof timer.unref === "function") timer.unref();
  };
  const connectorRuntimeSyncSignal = createConnectorRuntimeSyncSignalHandler({
    env: serverEnv,
    runRuntimeSync,
    whatsappDeliveryScheduler,
  });
  const clearConnectorDeliverySignalHandler = setThreadConnectorDeliverySignalHandler(connectorRuntimeSyncSignal.handleSignal);
  const clearDeliveryFailureHandler = setThreadInputDeliveryFailureHandler(() => {
    whatsappDeliveryScheduler.schedule();
  });
  const clearCodexAppServerMessageHandler = setCodexAppServerMessageHandler(() => {
    clearWhatsAppDeliveryIdleCache();
    whatsappDeliveryScheduler.schedule();
    scheduleWhatsAppDeliveryFollowUp();
  });

  registerTenantVmDesktopProxy(app);
  registerBrokerInstanceAppProxy(app);
  registerDesktopProxy(app);
  registerStaticFallback(app);
  await app.init();
  attachBrokerInstanceAppProxyUpgrade(app.getHttpServer());
  attachTenantVmDesktopProxyUpgrade(app.getHttpServer());
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
    await recordServerShutdown(process.env.ORKESTR_SHUTDOWN_SIGNAL || "server_close", serverEnv).catch(() => {});
    clearConnectorDeliverySignalHandler();
    connectorRuntimeSyncSignal.close();
    clearDeliveryFailureHandler();
    clearCodexAppServerMessageHandler();
    if (startupRecoveryTimer) clearTimeout(startupRecoveryTimer);
    clearInterval(whatsappDeliveryPoll);
    whatsappDeliveryScheduler.close();
    stopCodexAppServerClients();
    await stopLocalWhatsAppBridge(serverEnv).catch(() => {});
  });
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
  let handle: ReturnType<typeof serverHandle> | null = null;
  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    const timeoutMs = Number(process.env.ORKESTR_SHUTDOWN_FORCE_EXIT_MS || 10000);
    const forceExit = setTimeout(() => {
      console.error(`Forced Orkestr shutdown after ${timeoutMs}ms (${signal}).`);
      process.exit(0);
    }, Math.max(1000, timeoutMs));
    forceExit.unref?.();
    if (!handle) {
      clearTimeout(forceExit);
      process.exit(0);
    }
    process.env.ORKESTR_SHUTDOWN_SIGNAL = signal;
    handle.close((error) => {
      clearTimeout(forceExit);
      if (error) console.error(error?.stack || error?.message || String(error));
      process.exit(error ? 1 : 0);
    });
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
  startServer({ port, host, openBrowser: args.has("--open") }).then((server) => {
    handle = server;
  }).catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  });
}
