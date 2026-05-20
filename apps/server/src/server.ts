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
  setThreadInputDeliveryFailureHandler,
  syncPaneProgressForActiveLeases,
  syncRuntimeLeases,
} from "../../../packages/core/src/runtime-leases.js";
import { markDueTimers } from "../../../packages/core/src/timers.js";
import { deliverWhatsAppReplies } from "../../../packages/connectors/src/whatsapp.js";
import { ensureDataDirs } from "../../../packages/storage/src/paths.js";
import { authorizeHttpRequest } from "../../../packages/core/src/security.js";
import { AppModule } from "./app.module.js";
import { JsonErrorFilter } from "./common/json-error.filter.js";
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
      if (result.ok) return next();
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

export async function startServer({ port = 19812, host = "127.0.0.1", openBrowser = false } = {}) {
  await ensureDataDirs();
  if (process.env.ORKESTR_RECOVER_RUNNING_ON_START !== "0") {
    await recoverInterruptedExecutions();
  }
  await loadOverlayExecutorAdapters();
  const app = await createApp();

  const timer = setInterval(() => {
    runTimerLoop().catch(() => {});
  }, timerLoopIntervalMs());

  const runtimeMonitor = setInterval(() => {
    syncRuntimeAndDeliverWhatsApp().catch(() => {});
  }, runtimeMonitorIntervalMs());

  const paneProgressMonitor = setInterval(() => {
    syncPaneProgressForActiveLeases().catch(() => {});
  }, paneProgressMonitorIntervalMs());
  const whatsappDeliveryScheduler = createWhatsAppDeliveryScheduler();
  const clearDeliveryFailureHandler = setThreadInputDeliveryFailureHandler(() => {
    whatsappDeliveryScheduler.schedule();
  });

  registerStaticFallback(app);
  await app.init();
  attachThreadStreamUpgrade(app.getHttpServer());
  await app.listen(port, host);
  whatsappDeliveryScheduler.schedule();

  const url = `http://${host}:${port}`;
  console.log(`Orkestr setup wizard: ${url}`);
  if (openBrowser) {
    execFile("xdg-open", [url], { timeout: 1000 }, () => {});
  }

  return serverHandle(app, timer, runtimeMonitor, paneProgressMonitor, () => {
    clearDeliveryFailureHandler();
    whatsappDeliveryScheduler.close();
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

async function runTimerLoop() {
  const dueTimers = await markDueTimers();
  const drained = await drainAllPendingThreadInputs();
  const deliveredCount = drained.reduce((count: number, result: any) => count + Number(result?.delivered?.length || 0), 0);
  if (dueTimers.length || deliveredCount > 0 || drained.length > 0) {
    await syncRuntimeAndDeliverWhatsApp({ forceWhatsapp: true });
  }
}

async function syncRuntimeAndDeliverWhatsApp(options: { forceWhatsapp?: boolean } = {}) {
  const pendingConnectorDeliveries = consumeThreadConnectorDeliverySignalCount();
  const synced = await syncRuntimeLeases();
  const connectorDeliveries = pendingConnectorDeliveries + consumeThreadConnectorDeliverySignalCount();
  if (options.forceWhatsapp || (synced.appended || 0) > 0 || connectorDeliveries > 0) {
    await deliverWhatsAppReplies().catch(() => {});
  }
  return synced;
}

function createWhatsAppDeliveryScheduler() {
  let timer: NodeJS.Timeout | null = null;
  return {
    schedule() {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        deliverWhatsAppReplies().catch(() => {});
      }, 0);
      if (typeof timer.unref === "function") timer.unref();
    },
    close() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

export function serverHandle(
  app: INestApplication,
  timer?: NodeJS.Timeout,
  runtimeMonitor?: NodeJS.Timeout,
  paneProgressMonitor?: NodeJS.Timeout,
  cleanup?: () => void,
) {
  return {
    address: () => app.getHttpServer().address(),
    close: (callback?: (error?: Error) => void) => {
      if (timer) clearInterval(timer);
      if (runtimeMonitor) clearInterval(runtimeMonitor);
      if (paneProgressMonitor) clearInterval(paneProgressMonitor);
      cleanup?.();
      app.close()
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
