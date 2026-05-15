import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { createAgentFromTemplate, listAgents, templates } from "../../../packages/core/src/agents.js";
import { listExecutions, listExecutorAdapters, loadOverlayExecutorAdapters, runNextAgentMessage } from "../../../packages/core/src/executors.js";
import { enqueueAgentMessage, listAgentMessages } from "../../../packages/core/src/messages.js";
import { getSetupStatus } from "../../../packages/core/src/setup.js";
import { createTimer, deleteTimer, listTimers, markDueTimers, runTimerNow } from "../../../packages/core/src/timers.js";
import { listVirtualBrowsers, openVirtualBrowser, prepareVirtualBrowser } from "../../../packages/browsers/src/browsers.js";
import { finishGmailOAuth, getGmailMessage, listGmailMessages, startGmailOAuth } from "../../../packages/connectors/src/gmail.js";
import { getWhatsAppStatus, routeWhatsAppInbound } from "../../../packages/connectors/src/whatsapp.js";
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

function json(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload, null, 2));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function serveStatic(req, res) {
  const url = new URL(req.url, "http://localhost");
  const requested = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const safePath = path.normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(publicDir, safePath);
  const target = filePath.startsWith(publicDir) ? filePath : path.join(publicDir, "index.html");
  const ext = path.extname(target);
  try {
    const body = await fs.readFile(target);
    res.writeHead(200, {
      "content-type": mimeTypes.get(ext) || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(body);
  } catch {
    const body = await fs.readFile(path.join(publicDir, "index.html"));
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(body);
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

async function handleApi(req, res) {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "GET" && url.pathname === "/api/health") {
    json(res, 200, { ok: true, name: "orkestr", generatedAt: new Date().toISOString() });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/version") {
    json(res, 200, { ...(await appVersion()), generatedAt: new Date().toISOString() });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/ready") {
    const status = await getSetupStatus();
    json(res, 200, {
      ok: true,
      dataHome: await dataDirReady(),
      setupState: status.setupState,
      overlayValid: status.overlay.valid,
      generatedAt: new Date().toISOString(),
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/setup/status") {
    json(res, 200, { ...(await getSetupStatus()), config: await publicConfig() });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/connectors/gmail/oauth/start") {
    json(res, 200, await startGmailOAuth());
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/connectors/gmail/messages") {
    json(res, 200, await listGmailMessages({
      maxResults: url.searchParams.get("maxResults") || 10,
      query: url.searchParams.get("q") || "",
    }));
    return;
  }
  const gmailMessage = url.pathname.match(/^\/api\/connectors\/gmail\/messages\/([^/]+)$/);
  if (req.method === "GET" && gmailMessage) {
    json(res, 200, { message: await getGmailMessage(decodeURIComponent(gmailMessage[1])) });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/connectors/whatsapp/status") {
    json(res, 200, await getWhatsAppStatus());
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/connectors/whatsapp/inbound") {
    const routed = await routeWhatsAppInbound(await readJson(req));
    json(res, routed.duplicate ? 200 : 202, routed);
    return;
  }
  const connectorConfig = url.pathname.match(/^\/api\/connectors\/([^/]+)\/config$/);
  if (req.method === "POST" && connectorConfig) {
    json(res, 200, { config: await writeConnectorConfig(connectorConfig[1], await readJson(req)) });
    return;
  }
  if (req.method === "POST" && url.pathname.match(/^\/api\/connectors\/[^/]+\/test$/)) {
    const id = url.pathname.split("/")[3];
    const status = await getSetupStatus();
    const connector = status.connectors.find((item) => item.id === id);
    if (!connector) {
      json(res, 404, { error: "unknown_connector" });
      return;
    }
    json(res, 200, connector);
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/browsers") {
    json(res, 200, { browsers: await listVirtualBrowsers() });
    return;
  }
  const browserPrepare = url.pathname.match(/^\/api\/browsers\/([^/]+)\/prepare$/);
  if (req.method === "POST" && browserPrepare) {
    json(res, 200, { browser: await prepareVirtualBrowser(browserPrepare[1]) });
    return;
  }
  const browserOpen = url.pathname.match(/^\/api\/browsers\/([^/]+)\/open$/);
  if (req.method === "POST" && browserOpen) {
    json(res, 200, { browser: await openVirtualBrowser(browserOpen[1]) });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/agents/templates") {
    json(res, 200, { templates });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/agents") {
    json(res, 200, { agents: await listAgents() });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/executors") {
    await loadOverlayExecutorAdapters();
    json(res, 200, { executors: listExecutorAdapters() });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/executions") {
    json(res, 200, { executions: await listExecutions() });
    return;
  }
  const agentTemplate = url.pathname.match(/^\/api\/agents\/templates\/([^/]+)$/);
  if (req.method === "POST" && agentTemplate) {
    json(res, 201, { agent: await createAgentFromTemplate(agentTemplate[1]) });
    return;
  }
  const agentMessages = url.pathname.match(/^\/api\/agents\/([^/]+)\/messages$/);
  if (req.method === "GET" && agentMessages) {
    json(res, 200, { messages: await listAgentMessages(agentMessages[1]) });
    return;
  }
  if (req.method === "POST" && agentMessages) {
    json(res, 201, { message: await enqueueAgentMessage(agentMessages[1], await readJson(req)) });
    return;
  }
  const agentRun = url.pathname.match(/^\/api\/agents\/([^/]+)\/run-next$/);
  if (req.method === "POST" && agentRun) {
    json(res, 200, { execution: await runNextAgentMessage(agentRun[1], await readJson(req)) });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/timers") {
    json(res, 200, { timers: await listTimers() });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/timers") {
    json(res, 201, { timer: await createTimer(await readJson(req)) });
    return;
  }
  const timerDelete = url.pathname.match(/^\/api\/timers\/([^/]+)$/);
  if (req.method === "DELETE" && timerDelete) {
    json(res, 200, { ok: await deleteTimer(timerDelete[1]) });
    return;
  }
  const timerRun = url.pathname.match(/^\/api\/timers\/([^/]+)\/run$/);
  if (req.method === "POST" && timerRun) {
    json(res, 200, { event: await runTimerNow(timerRun[1]) });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/events") {
    json(res, 200, { events: await listEvents(process.env, Number(url.searchParams.get("limit") || 100)) });
    return;
  }
  json(res, 404, { error: "not_found" });
}

export async function startServer({ port = 19812, host = "127.0.0.1", openBrowser = false } = {}) {
  await ensureDataDirs();
  await loadOverlayExecutorAdapters();
  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      json(res, error.statusCode || 500, {
        error: error.message || "internal_error",
      });
    });
  });

  const timer = setInterval(() => {
    markDueTimers().catch(() => {});
  }, 30_000);
  server.on("close", () => clearInterval(timer));

  await new Promise((resolve) => server.listen(port, host, resolve));
  const url = `http://${host}:${port}`;
  console.log(`Orkestr setup wizard: ${url}`);
  if (openBrowser) {
    execFile("xdg-open", [url], { timeout: 1000 }, () => {});
  }
  return server;
}

async function handleRequest(req, res) {
  if (req.url.startsWith("/oauth/gmail/callback")) {
    const url = new URL(req.url, "http://localhost");
    const result = await finishGmailOAuth(url.searchParams);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(`<!doctype html><title>Gmail connected</title><h1>Gmail callback received</h1><p>State: ${escapeHtml(result.state)}</p>`);
    return;
  }
  if (req.url.startsWith("/api/")) {
    await handleApi(req, res);
    return;
  }
  await serveStatic(req, res);
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
