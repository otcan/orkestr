import "reflect-metadata";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { loadOverlayExecutorAdapters, recoverInterruptedExecutions } from "../../../packages/core/src/executors.js";
import { drainAllPendingThreadInputs, syncRuntimeLeases } from "../../../packages/core/src/runtime-leases.js";
import { markDueTimers } from "../../../packages/core/src/timers.js";
import { deliverWhatsAppReplies } from "../../../packages/connectors/src/whatsapp.js";
import { ensureDataDirs } from "../../../packages/storage/src/paths.js";
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
    markDueTimers()
      .then(() => drainAllPendingThreadInputs())
      .then(() => syncRuntimeAndDeliverWhatsApp())
      .catch(() => {});
  }, 30_000);

  const runtimeMonitor = setInterval(() => {
    syncRuntimeAndDeliverWhatsApp().catch(() => {});
  }, 5_000);

  registerStaticFallback(app);
  await app.init();
  attachThreadStreamUpgrade(app.getHttpServer());
  await app.listen(port, host);

  const url = `http://${host}:${port}`;
  console.log(`Orkestr setup wizard: ${url}`);
  if (openBrowser) {
    execFile("xdg-open", [url], { timeout: 1000 }, () => {});
  }

  return serverHandle(app, timer, runtimeMonitor);
}

async function syncRuntimeAndDeliverWhatsApp() {
  const synced = await syncRuntimeLeases();
  if ((synced.appended || 0) > 0) {
    await deliverWhatsAppReplies().catch(() => {});
  }
  return synced;
}

export function serverHandle(app: INestApplication, timer?: NodeJS.Timeout, runtimeMonitor?: NodeJS.Timeout) {
  return {
    address: () => app.getHttpServer().address(),
    close: (callback?: (error?: Error) => void) => {
      if (timer) clearInterval(timer);
      if (runtimeMonitor) clearInterval(runtimeMonitor);
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
