#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const requiredSetupConnectors = ["codex", "whatsapp", "browsers", "timers"];
const authBlockedStatuses = new Set([401, 403]);

function isoStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function safeName(value, fallback = "target") {
  return String(value || fallback)
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || fallback;
}

function normalizeBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const url = new URL(raw);
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function parseTarget(raw, index = 0) {
  const text = String(raw || "").trim();
  if (!text) return null;
  const named = text.match(/^([A-Za-z0-9_.-]+)=(https?:\/\/.+)$/);
  if (named) {
    return { name: safeName(named[1], `target-${index + 1}`), baseUrl: normalizeBaseUrl(named[2]) };
  }
  const url = normalizeBaseUrl(text);
  const hostname = new URL(url).hostname;
  return { name: safeName(hostname || `target-${index + 1}`, `target-${index + 1}`), baseUrl: url };
}

function parseTargetsFromEnv(env = {}) {
  const raw = String(env.ORKESTR_RELEASE_CHECK_URLS || "").trim();
  if (raw) return raw.split(",").map((part, index) => parseTarget(part, index)).filter(Boolean);
  const base = String(env.ORKESTR_API_BASE || "").trim();
  if (base) return [parseTarget(`local=${base}`, 0)].filter(Boolean);
  const host = String(env.ORKESTR_HOST || "127.0.0.1").trim() || "127.0.0.1";
  const port = String(env.ORKESTR_PORT || env.PORT || "19812").trim() || "19812";
  return [parseTarget(`local=http://${host}:${port}`, 0)].filter(Boolean);
}

function parseHeader(raw) {
  const text = String(raw || "");
  const index = text.indexOf(":");
  if (index <= 0) throw new Error(`Invalid header "${text}". Use "Name: value".`);
  return [text.slice(0, index).trim(), text.slice(index + 1).trim()];
}

export function parseReleaseRegressionArgs(argv = [], env = process.env) {
  const options = {
    targets: [],
    headers: {},
    timeoutMs: Number(env.ORKESTR_RELEASE_CHECK_TIMEOUT_MS || 5000) || 5000,
    pollMs: Number(env.ORKESTR_RELEASE_CHECK_POLL_MS || 1000) || 1000,
    artifactDir: String(env.ORKESTR_RELEASE_CHECK_ARTIFACT_DIR || "").trim(),
    releaseId: String(env.ORKESTR_RELEASE_ID || "").trim(),
    execute: false,
    allowAuthBlocked: false,
    threadId: String(env.ORKESTR_RELEASE_TEST_THREAD || "").trim(),
    linkedInThreadId: String(env.ORKESTR_RELEASE_LINKEDIN_THREAD || "").trim(),
    desktopSlug: String(env.ORKESTR_RELEASE_DESKTOP_SLUG || "").trim(),
    message: String(env.ORKESTR_RELEASE_TEST_MESSAGE || "").trim(),
    expect: String(env.ORKESTR_RELEASE_TEST_EXPECT || "").trim(),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--target") options.targets.push(parseTarget(argv[++index], options.targets.length));
    else if (arg === "--base-url") options.targets.push(parseTarget(argv[++index], options.targets.length));
    else if (arg === "--header") {
      const [name, value] = parseHeader(argv[++index]);
      options.headers[name] = value;
    } else if (arg === "--artifact-dir") options.artifactDir = String(argv[++index] || "").trim();
    else if (arg === "--release-id") options.releaseId = String(argv[++index] || "").trim();
    else if (arg === "--timeout-ms") options.timeoutMs = Number(argv[++index] || 0) || options.timeoutMs;
    else if (arg === "--poll-ms") options.pollMs = Number(argv[++index] || 0) || options.pollMs;
    else if (arg === "--execute") options.execute = true;
    else if (arg === "--allow-auth-blocked") options.allowAuthBlocked = true;
    else if (arg === "--thread") options.threadId = String(argv[++index] || "").trim();
    else if (arg === "--linkedin-thread") options.linkedInThreadId = String(argv[++index] || "").trim();
    else if (arg === "--desktop-slug") options.desktopSlug = String(argv[++index] || "").trim();
    else if (arg === "--message") options.message = String(argv[++index] || "").trim();
    else if (arg === "--expect") options.expect = String(argv[++index] || "").trim();
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  options.targets = options.targets.filter(Boolean);
  if (!options.targets.length) options.targets = parseTargetsFromEnv(env);
  if (!options.releaseId) options.releaseId = `release-check-${isoStamp()}`;
  if (!options.artifactDir) {
    const home = String(env.ORKESTR_HOME || "").trim() || path.join(os.tmpdir(), "orkestr-release-checks");
    options.artifactDir = path.join(home, "release-checks", safeName(options.releaseId, "release-check"));
  }
  if (!options.message) {
    options.message = `ORK RELEASE REGRESSION CHECK ${options.releaseId}: reply exactly "ORK RELEASE REGRESSION CHECK OK".`;
  }
  if (!options.expect) options.expect = "ORK RELEASE REGRESSION CHECK OK";
  return options;
}

function publicSummary(payload) {
  if (!payload || typeof payload !== "object") return payload;
  const copy = Array.isArray(payload) ? [...payload] : { ...payload };
  for (const key of Object.keys(copy)) {
    if (/token|secret|password|cookie|sessionRoot|profile_path|profilePath|cdp_url|cdpUrl/i.test(key)) {
      copy[key] = "[redacted]";
    } else if (copy[key] && typeof copy[key] === "object") {
      copy[key] = publicSummary(copy[key]);
    }
  }
  return copy;
}

async function writeArtifact(artifacts, targetName, scenarioName, data) {
  const dir = path.join(artifacts.root, safeName(targetName));
  await artifacts.fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${safeName(scenarioName)}.json`);
  await artifacts.fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  return file;
}

class HttpStatusError extends Error {
  constructor(route, status, body, payload) {
    super(`${route} returned HTTP ${status}`);
    this.status = status;
    this.body = body;
    this.payload = payload;
  }
}

async function requestJson(target, route, options, deps) {
  const url = new URL(route, `${target.baseUrl}/`).toString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, options.timeoutMs));
  try {
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const response = await deps.fetch(url, {
      method: options.method || "GET",
      signal: controller.signal,
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...options.headers,
      },
      body,
    });
    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { raw: text };
      }
    }
    if (!response.ok) throw new HttpStatusError(route, response.status, text, payload);
    return { status: response.status, payload };
  } finally {
    clearTimeout(timeout);
  }
}

function scenarioPass(name, detail = {}) {
  return { name, status: "pass", ok: true, ...detail };
}

function scenarioSkip(name, reason, detail = {}) {
  return { name, status: "skip", ok: true, reason, ...detail };
}

function scenarioFail(name, error, detail = {}) {
  return {
    name,
    status: "fail",
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    ...detail,
  };
}

function scenarioAuthBlocked(name, error, allowAuthBlocked) {
  if (allowAuthBlocked && authBlockedStatuses.has(Number(error?.status || 0))) {
    return scenarioSkip(name, "auth_required", { statusCode: error.status });
  }
  return scenarioFail(name, error, { statusCode: error?.status || null });
}

function connectorsById(setupPayload = {}) {
  const connectors = Array.isArray(setupPayload.connectors) ? setupPayload.connectors : [];
  return new Map(connectors.map((connector) => [String(connector.id || ""), connector]));
}

function threadList(payload = {}) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.threads)) return payload.threads;
  if (Array.isArray(payload.items)) return payload.items;
  return [];
}

function desktopSessions(payload = {}) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.sessions)) return payload.sessions;
  if (Array.isArray(payload.browsers)) return payload.browsers;
  if (Array.isArray(payload.desktops)) return payload.desktops;
  return [];
}

function whatsappReady(payload = {}) {
  const state = String(payload.state || payload.status || "").toLowerCase();
  const health = payload.health && typeof payload.health === "object" ? payload.health : {};
  const accounts = Array.isArray(payload.accounts) ? payload.accounts : Array.isArray(health.accounts) ? health.accounts : [];
  return state === "paired" ||
    state === "connected" ||
    health.ready === true ||
    accounts.some((account) => account?.ready === true || String(account?.state || "").toLowerCase() === "ready");
}

async function runScenario(name, target, options, artifacts, callback) {
  try {
    const result = await callback();
    const artifact = await writeArtifact(artifacts, target.name, name, { ...result, target: target.name });
    return { ...result, artifact };
  } catch (error) {
    const result = scenarioFail(name, error, {
      statusCode: error?.status || null,
      payload: publicSummary(error?.payload || null),
    });
    const artifact = await writeArtifact(artifacts, target.name, name, { ...result, target: target.name });
    return { ...result, artifact };
  }
}

async function checkCore(target, options, artifacts, deps) {
  return runScenario("core-health", target, options, artifacts, async () => {
    const version = await requestJson(target, "/api/version", options, deps);
    const ready = await requestJson(target, "/api/ready", options, deps);
    if (!version.payload?.name || !version.payload?.version) throw new Error("version payload is missing name/version");
    if (ready.payload?.ok !== true) throw new Error("ready payload did not report ok=true");
    return scenarioPass("core-health", {
      version: publicSummary(version.payload),
      ready: publicSummary(ready.payload),
    });
  });
}

async function checkSetup(target, options, artifacts, deps) {
  return runScenario("setup-connectors", target, options, artifacts, async () => {
    const setup = await requestJson(target, "/api/setup/status", options, deps);
    const byId = connectorsById(setup.payload);
    const missing = requiredSetupConnectors.filter((id) => !byId.has(id));
    if (missing.length) throw new Error(`setup status missing connectors: ${missing.join(", ")}`);
    return scenarioPass("setup-connectors", {
      setupState: setup.payload?.setupState || setup.payload?.state || null,
      connectors: requiredSetupConnectors.map((id) => ({
        id,
        state: byId.get(id)?.state || null,
      })),
    });
  });
}

async function checkThreads(target, options, artifacts, deps) {
  return runScenario("thread-summary", target, options, artifacts, async () => {
    try {
      const summary = await requestJson(target, "/api/threads?scope=all", options, deps);
      return scenarioPass("thread-summary", {
        threadCount: threadList(summary.payload).length,
      });
    } catch (error) {
      return scenarioAuthBlocked("thread-summary", error, options.allowAuthBlocked);
    }
  });
}

async function checkWhatsApp(target, options, artifacts, deps) {
  return runScenario("whatsapp-readiness", target, options, artifacts, async () => {
    try {
      const status = await requestJson(target, "/api/connectors/whatsapp/status", options, deps);
      if (!whatsappReady(status.payload)) {
        throw new Error(`WhatsApp is not ready: ${status.payload?.state || status.payload?.status || "unknown"}`);
      }
      return scenarioPass("whatsapp-readiness", {
        state: status.payload?.state || status.payload?.status || null,
        accountCount: Array.isArray(status.payload?.accounts) ? status.payload.accounts.length : 0,
      });
    } catch (error) {
      return scenarioAuthBlocked("whatsapp-readiness", error, options.allowAuthBlocked);
    }
  });
}

async function checkDesktops(target, options, artifacts, deps) {
  return runScenario("desktop-sessions", target, options, artifacts, async () => {
    try {
      const sessions = await requestJson(target, "/api/browser-sessions", options, deps);
      const list = desktopSessions(sessions.payload);
      if (!Array.isArray(list)) throw new Error("browser-sessions payload did not contain a session list");
      const slug = String(options.desktopSlug || "").trim();
      if (slug) {
        const session = list.find((item) => String(item.slug || item.id || "").trim() === slug);
        if (!session) throw new Error(`desktop session not found: ${slug}`);
        const status = String(session.status || session.state || "").toLowerCase();
        if (status && !["active", "ready", "running", "connected"].includes(status)) {
          throw new Error(`desktop ${slug} is not active: ${status}`);
        }
      }
      return scenarioPass("desktop-sessions", {
        sessionCount: list.length,
        requiredDesktop: slug || null,
      });
    } catch (error) {
      return scenarioAuthBlocked("desktop-sessions", error, options.allowAuthBlocked);
    }
  });
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function messageMatches(message, text) {
  return String(message?.text || "").trim() === String(text || "").trim();
}

async function pollThreadMessages(target, threadId, options, deps) {
  const deadline = Date.now() + Math.max(options.timeoutMs, options.pollMs);
  let latest = null;
  while (Date.now() <= deadline) {
    latest = await requestJson(target, `/api/threads/${encodeURIComponent(threadId)}/messages?limit=20`, options, deps);
    const messages = Array.isArray(latest.payload?.messages) ? latest.payload.messages : [];
    const hasUser = messages.some((message) => String(message.role || message.kind || "") === "user" && messageMatches(message, options.message));
    const hasExpected = !options.expect || messages.some((message) => String(message.role || message.kind || "") === "assistant" && messageMatches(message, options.expect));
    if (hasUser && hasExpected) return { payload: latest.payload, messages };
    await sleep(options.pollMs);
  }
  return { payload: latest?.payload || null, messages: Array.isArray(latest?.payload?.messages) ? latest.payload.messages : [] };
}

async function checkChatInjection(target, options, artifacts, deps) {
  return runScenario("chat-injection", target, options, artifacts, async () => {
    if (!options.execute) return scenarioSkip("chat-injection", "requires_--execute");
    if (!options.threadId) return scenarioSkip("chat-injection", "missing_--thread");
    try {
      const input = await requestJson(target, `/api/threads/${encodeURIComponent(options.threadId)}/input`, {
        ...options,
        method: "POST",
        body: {
          text: options.message,
          source: "release_regression",
          controlAllowed: false,
        },
      }, deps);
      const registeredText = input.payload?.message?.text || "";
      if (registeredText && registeredText !== options.message) {
        throw new Error("input response did not preserve the submitted message text");
      }
      const observed = await pollThreadMessages(target, options.threadId, options, deps);
      const hasUser = observed.messages.some((message) => String(message.role || message.kind || "") === "user" && messageMatches(message, options.message));
      if (!hasUser) throw new Error("submitted message was not visible in the thread message list");
      if (options.expect) {
        const hasExpected = observed.messages.some((message) => String(message.role || message.kind || "") === "assistant" && messageMatches(message, options.expect));
        if (!hasExpected) throw new Error("expected assistant reply was not observed before timeout");
      }
      return scenarioPass("chat-injection", {
        threadId: options.threadId,
        messageId: input.payload?.message?.id || null,
      });
    } catch (error) {
      return scenarioAuthBlocked("chat-injection", error, options.allowAuthBlocked);
    }
  });
}

async function checkLinkedInChat(target, options, artifacts, deps) {
  return runScenario("linkedin-chat-delivery", target, options, artifacts, async () => {
    if (!options.execute) return scenarioSkip("linkedin-chat-delivery", "requires_--execute");
    if (!options.linkedInThreadId) return scenarioSkip("linkedin-chat-delivery", "missing_--linkedin-thread");
    const linkedInOptions = {
      ...options,
      threadId: options.linkedInThreadId,
      message: `ORK LINKEDIN RELEASE CHECK ${options.releaseId}: report delivery status only; do not send external LinkedIn outreach.`,
      expect: "",
    };
    const input = await requestJson(target, `/api/threads/${encodeURIComponent(linkedInOptions.threadId)}/input`, {
      ...linkedInOptions,
      method: "POST",
      body: {
        text: linkedInOptions.message,
        source: "release_regression_linkedin",
        controlAllowed: false,
      },
    }, deps);
    const deliveryState = input.payload?.deliveryState || input.payload?.message?.deliveryState || input.payload?.message?.state || "";
    if (!input.payload?.ok && !deliveryState) throw new Error("LinkedIn thread input did not return a delivery state");
    return scenarioPass("linkedin-chat-delivery", {
      threadId: linkedInOptions.threadId,
      deliveryState: deliveryState || null,
      queued: Boolean(input.payload?.queued),
      messageId: input.payload?.message?.id || null,
    });
  });
}

async function runTarget(target, options, artifacts, deps) {
  const scenarios = [];
  for (const check of [checkCore, checkSetup, checkThreads, checkWhatsApp, checkDesktops, checkChatInjection, checkLinkedInChat]) {
    scenarios.push(await check(target, options, artifacts, deps));
  }
  return {
    target: target.name,
    baseUrl: target.baseUrl,
    ok: scenarios.every((scenario) => scenario.ok),
    scenarios,
  };
}

export async function runReleaseRegression(options, deps = {}) {
  const effective = {
    ...options,
    timeoutMs: Math.max(1, Number(options.timeoutMs || 5000) || 5000),
    pollMs: Math.max(100, Number(options.pollMs || 1000) || 1000),
  };
  const artifacts = {
    root: effective.artifactDir,
    fs: deps.fs || fs,
  };
  const runtimeDeps = {
    fetch: deps.fetch || globalThis.fetch,
  };
  if (typeof runtimeDeps.fetch !== "function") throw new Error("fetch is not available");
  await artifacts.fs.mkdir(artifacts.root, { recursive: true, mode: 0o700 });
  const targets = [];
  for (const target of effective.targets) targets.push(await runTarget(target, effective, artifacts, runtimeDeps));
  const summary = {
    ok: targets.every((target) => target.ok),
    releaseId: effective.releaseId,
    generatedAt: new Date().toISOString(),
    artifactDir: artifacts.root,
    execute: Boolean(effective.execute),
    targets,
  };
  await artifacts.fs.writeFile(path.join(artifacts.root, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  return summary;
}

export function formatSummary(summary) {
  const lines = [
    `Release regression ${summary.ok ? "passed" : "failed"} for ${summary.releaseId}`,
    `Artifacts: ${summary.artifactDir}`,
  ];
  for (const target of summary.targets || []) {
    lines.push(`${target.ok ? "ok" : "fail"} ${target.target} ${target.baseUrl}`);
    for (const scenario of target.scenarios || []) {
      const suffix = scenario.reason ? ` (${scenario.reason})` : scenario.error ? ` (${scenario.error})` : "";
      lines.push(`  ${scenario.ok ? "ok" : "fail"} ${scenario.name}: ${scenario.status}${suffix}`);
    }
  }
  return lines.join("\n");
}
