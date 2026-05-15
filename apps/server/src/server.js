import { execFile } from "node:child_process";
import Fastify from "fastify";
import { loadOverlayExecutorAdapters } from "../../../packages/core/src/executors.js";
import { markDueTimers } from "../../../packages/core/src/timers.js";
import { ensureDataDirs } from "../../../packages/storage/src/paths.js";
import { installJsonParser, json, serverHandle } from "./http.js";
import { registerAgentRoutes } from "./routes/agents.routes.js";
import { registerBrowserRoutes } from "./routes/browsers.routes.js";
import { registerConnectorCallbackRoutes, registerConnectorRoutes } from "./routes/connectors.routes.js";
import { registerStaticRoutes } from "./routes/static.routes.js";
import { registerSystemRoutes } from "./routes/system.routes.js";
import { registerTimerRoutes } from "./routes/timers.routes.js";

export async function createApp() {
  const app = Fastify({ logger: false });

  installJsonParser(app);

  app.setErrorHandler((error, _request, reply) => {
    json(reply, error.statusCode || 500, {
      error: error.message || "internal_error",
    });
  });

  await registerSystemRoutes(app);
  await registerConnectorRoutes(app);
  await registerBrowserRoutes(app);
  await registerAgentRoutes(app);
  await registerTimerRoutes(app);
  await registerConnectorCallbackRoutes(app);
  await registerStaticRoutes(app);

  return app;
}

export async function startServer({ port = 19812, host = "127.0.0.1", openBrowser = false } = {}) {
  await ensureDataDirs();
  await loadOverlayExecutorAdapters();
  const app = await createApp();

  const timer = setInterval(() => {
    markDueTimers().catch(() => {});
  }, 30_000);
  app.addHook("onClose", async () => clearInterval(timer));

  await app.listen({ port, host });
  const url = `http://${host}:${port}`;
  console.log(`Orkestr setup wizard: ${url}`);
  if (openBrowser) {
    execFile("xdg-open", [url], { timeout: 1000 }, () => {});
  }
  return serverHandle(app);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = new Set(process.argv.slice(2));
  const port = Number(process.env.PORT || process.env.ORKESTR_PORT || 19812);
  const host = process.env.ORKESTR_HOST || "127.0.0.1";
  startServer({ port, host, openBrowser: args.has("--open") }).catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  });
}
