import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import Fastify from "fastify";
import { createAgentFromTemplate, listAgents, templates } from "../../../packages/core/src/agents.js";
import { listExecutions, listExecutorAdapters, loadOverlayExecutorAdapters, runNextAgentMessage } from "../../../packages/core/src/executors.js";
import { enqueueAgentMessage, listAgentMessages } from "../../../packages/core/src/messages.js";
import { getSetupStatus } from "../../../packages/core/src/setup.js";
import { createTimer, deleteTimer, listTimers, markDueTimers, runTimerNow } from "../../../packages/core/src/timers.js";
import { listVirtualBrowsers, openVirtualBrowser, prepareVirtualBrowser } from "../../../packages/browsers/src/browsers.js";
import { finishGmailOAuth, getGmailMessage, listGmailMessages, startGmailOAuth } from "../../../packages/connectors/src/gmail.js";
import { deliverWhatsAppReplies, getWhatsAppStatus, routeWhatsAppInbound } from "../../../packages/connectors/src/whatsapp.js";
import { publicConfig, writeConnectorConfig } from "../../../packages/storage/src/config.js";
import { ensureDataDirs } from "../../../packages/storage/src/paths.js";
import { listEvents } from "../../../packages/storage/src/store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "../../web/public");
const packagePath = path.resolve(__dirname, "../../../package.json");

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function json(reply, statusCode, payload) {
  return reply
    .code(statusCode)
    .header("cache-control", "no-store")
    .type("application/json; charset=utf-8")
    .send(payload);
}

async function serveStaticPath(pathname, reply) {
  const url = new URL(pathname, "http://localhost");
  const requested = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const safePath = path.normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(publicDir, safePath);
  const target = filePath.startsWith(publicDir) ? filePath : path.join(publicDir, "index.html");
  const ext = path.extname(target);
  try {
    const body = await fs.readFile(target);
    return reply
      .code(200)
      .header("cache-control", "no-store")
      .type(mimeTypes.get(ext) || "application/octet-stream")
      .send(body);
  } catch {
    const body = await fs.readFile(path.join(publicDir, "index.html"));
    return reply
      .code(200)
      .header("cache-control", "no-store")
      .type("text/html; charset=utf-8")
      .send(body);
  }
}

async function appVersion() {
  const pkg = JSON.parse(await fs.readFile(packagePath, "utf8"));
  return {
    name: pkg.name || "orkestr",
    version: pkg.version || "0.0.0",
  };
}

async function dataDirReady() {
  const paths = await ensureDataDirs();
  const probe = path.join(paths.home, ".ready-check");
  await fs.writeFile(probe, new Date().toISOString());
  await fs.unlink(probe).catch(() => {});
  return paths.home;
}

export async function createApp() {
  const app = Fastify({ logger: false });

  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
    const text = String(body || "").trim();
    if (!text) {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(text));
    } catch (error) {
      done(error);
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    json(reply, error.statusCode || 500, {
      error: error.message || "internal_error",
    });
  });

  app.get("/api/health", async (_request, reply) => {
    return json(reply, 200, { ok: true, name: "orkestr", generatedAt: new Date().toISOString() });
  });

  app.get("/api/version", async (_request, reply) => {
    return json(reply, 200, { ...(await appVersion()), generatedAt: new Date().toISOString() });
  });

  app.get("/api/ready", async (_request, reply) => {
    const status = await getSetupStatus();
    return json(reply, 200, {
      ok: true,
      dataHome: await dataDirReady(),
      setupState: status.setupState,
      overlayValid: status.overlay.valid,
      generatedAt: new Date().toISOString(),
    });
  });

  app.get("/api/setup/status", async (_request, reply) => {
    return json(reply, 200, { ...(await getSetupStatus()), config: await publicConfig() });
  });

  app.get("/api/connectors/gmail/oauth/start", async (_request, reply) => {
    return json(reply, 200, await startGmailOAuth());
  });

  app.get("/api/connectors/gmail/messages", async (request, reply) => {
    return json(reply, 200, await listGmailMessages({
      maxResults: request.query.maxResults || 10,
      query: request.query.q || "",
    }));
  });

  app.get("/api/connectors/gmail/messages/:id", async (request, reply) => {
    return json(reply, 200, { message: await getGmailMessage(request.params.id) });
  });

  app.get("/api/connectors/whatsapp/status", async (_request, reply) => {
    return json(reply, 200, await getWhatsAppStatus());
  });

  app.post("/api/connectors/whatsapp/inbound", async (request, reply) => {
    const routed = await routeWhatsAppInbound(request.body || {});
    return json(reply, routed.duplicate ? 200 : 202, routed);
  });

  app.post("/api/connectors/whatsapp/deliver", async (_request, reply) => {
    return json(reply, 200, await deliverWhatsAppReplies());
  });

  app.post("/api/connectors/:id/config", async (request, reply) => {
    return json(reply, 200, { config: await writeConnectorConfig(request.params.id, request.body || {}) });
  });

  app.post("/api/connectors/:id/test", async (request, reply) => {
    const status = await getSetupStatus();
    const connector = status.connectors.find((item) => item.id === request.params.id);
    if (!connector) return json(reply, 404, { error: "unknown_connector" });
    return json(reply, 200, connector);
  });

  app.get("/api/browsers", async (_request, reply) => {
    return json(reply, 200, { browsers: await listVirtualBrowsers() });
  });

  app.post("/api/browsers/:slug/prepare", async (request, reply) => {
    return json(reply, 200, { browser: await prepareVirtualBrowser(request.params.slug) });
  });

  app.post("/api/browsers/:slug/open", async (request, reply) => {
    return json(reply, 200, { browser: await openVirtualBrowser(request.params.slug) });
  });

  app.get("/api/agents/templates", async (_request, reply) => {
    return json(reply, 200, { templates });
  });

  app.post("/api/agents/templates/:templateId", async (request, reply) => {
    return json(reply, 201, { agent: await createAgentFromTemplate(request.params.templateId) });
  });

  app.get("/api/agents", async (_request, reply) => {
    return json(reply, 200, { agents: await listAgents() });
  });

  app.get("/api/executors", async (_request, reply) => {
    await loadOverlayExecutorAdapters();
    return json(reply, 200, { executors: listExecutorAdapters() });
  });

  app.get("/api/executions", async (_request, reply) => {
    return json(reply, 200, { executions: await listExecutions() });
  });

  app.get("/api/agents/:agentId/messages", async (request, reply) => {
    return json(reply, 200, { messages: await listAgentMessages(request.params.agentId) });
  });

  app.post("/api/agents/:agentId/messages", async (request, reply) => {
    return json(reply, 201, { message: await enqueueAgentMessage(request.params.agentId, request.body || {}) });
  });

  app.post("/api/agents/:agentId/run-next", async (request, reply) => {
    const execution = await runNextAgentMessage(request.params.agentId, request.body || {});
    const whatsappDelivery = await deliverWhatsAppReplies().catch((error) => ({ error: error.message || String(error) }));
    return json(reply, 200, { execution, whatsappDelivery });
  });

  app.get("/api/timers", async (_request, reply) => {
    return json(reply, 200, { timers: await listTimers() });
  });

  app.post("/api/timers", async (request, reply) => {
    return json(reply, 201, { timer: await createTimer(request.body || {}) });
  });

  app.delete("/api/timers/:timerId", async (request, reply) => {
    return json(reply, 200, { ok: await deleteTimer(request.params.timerId) });
  });

  app.post("/api/timers/:timerId/run", async (request, reply) => {
    return json(reply, 200, { event: await runTimerNow(request.params.timerId) });
  });

  app.get("/api/events", async (request, reply) => {
    return json(reply, 200, { events: await listEvents(process.env, Number(request.query.limit || 100)) });
  });

  app.get("/oauth/gmail/callback", async (request, reply) => {
    const result = await finishGmailOAuth(new URLSearchParams(request.query));
    return reply
      .code(200)
      .header("cache-control", "no-store")
      .type("text/html; charset=utf-8")
      .send(`<!doctype html><title>Gmail connected</title><h1>Gmail callback received</h1><p>State: ${escapeHtml(result.state)}</p>`);
  });

  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith("/api/")) return json(reply, 404, { error: "not_found" });
    return serveStaticPath(request.url, reply);
  });

  return app;
}

function serverHandle(app) {
  return {
    address: () => app.server.address(),
    close: (callback) => {
      app.close()
        .then(() => callback?.())
        .catch((error) => callback?.(error));
    },
  };
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
