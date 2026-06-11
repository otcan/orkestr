#!/usr/bin/env node
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { sendWhatsAppText } from "../packages/connectors/src/whatsapp.js";
import { ensureBrokerClientRegistration } from "../packages/core/src/broker-instance-registry.js";
import { writeRuntimeSettings } from "../packages/core/src/runtime-settings.js";
import { writeConnectorConfig } from "../packages/storage/src/config.js";

function clean(value) {
  return String(value || "").trim();
}

function truthy(value) {
  return ["1", "true", "yes", "on"].includes(clean(value).toLowerCase());
}

function firstValue(...values) {
  for (const value of values) {
    const text = clean(value);
    if (text) return text;
  }
  return "";
}

function isLocalUrl(value = "") {
  try {
    const parsed = new URL(clean(value));
    return ["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function normalizePublicBaseUrl(value = "") {
  const text = clean(value).replace(/\/+$/, "");
  if (!text) return "";
  try {
    const parsed = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) return "";
    parsed.hash = "";
    parsed.search = "";
    parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function normalizeInstanceId(value = "") {
  return clean(value)
    .replace(/[^A-Za-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function demoInstanceId(env = process.env) {
  return normalizeInstanceId(firstValue(
    env.ORKESTR_DEMO_INSTANCE_ID,
    env.ORKESTR_INSTANCE_ID,
    env.ORKESTR_RELEASE_INSTANCE_ID,
    env.ORKESTR_TENANT_VM_ID,
    env.ORKESTR_SERVICE_NAME,
    "local",
  ));
}

async function demoBrokerRegistration(env = process.env, options = {}) {
  if (truthy(env.ORKESTR_DEMO_ALLOW_STATIC_INSTANCE_ID)) {
    const instanceId = demoInstanceId(env);
    if (instanceId) return { ok: true, instanceId, source: "static_instance_id" };
  }
  const brokerBaseUrl = firstValue(
    env.ORKESTR_DEMO_BROKER_BASE_URL,
    env.ORKESTR_BROKER_BASE_URL,
    demoInternalUrl(env),
  );
  return ensureBrokerClientRegistration({
    ...env,
    ORKESTR_DEMO_BROKER_BASE_URL: brokerBaseUrl,
  }, {
    fetchImpl: options.fetchImpl || fetch,
    brokerBaseUrl,
  });
}

function setupReturnPathFromUrl(value = "") {
  try {
    const parsed = new URL(clean(value));
    return `${parsed.pathname || "/setup"}${parsed.search || ""}` || "/setup";
  } catch {
    return "/setup";
  }
}

function pairingSetupUrl(baseOrUrl = "", { returnTo = "/setup", instanceId = "" } = {}) {
  const base = normalizePublicBaseUrl(baseOrUrl);
  if (!base) return "";
  try {
    const url = new URL("/setup/pairing", base);
    const normalizedInstanceId = normalizeInstanceId(instanceId);
    if (normalizedInstanceId) url.searchParams.set("instanceId", normalizedInstanceId);
    url.searchParams.set("return", clean(returnTo) || "/setup");
    return url.toString();
  } catch {
    return "";
  }
}

function setupUrlWithInstanceId(value = "", instanceId = "") {
  const setupUrl = clean(value);
  const normalizedInstanceId = normalizeInstanceId(instanceId);
  if (!setupUrl || !normalizedInstanceId) return setupUrl;
  try {
    const url = new URL(setupUrl);
    if (!url.searchParams.get("instanceId")) url.searchParams.set("instanceId", normalizedInstanceId);
    return url.toString();
  } catch {
    return setupUrl;
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function normalizeWhatsAppChatId(value) {
  const text = clean(value);
  if (!text) return "";
  if (text.includes("@")) return text;
  const digits = text.replace(/[^\d]/g, "");
  return digits ? `${digits}@c.us` : "";
}

function demoSetupUrl(env = process.env) {
  return firstValue(
    env.ORKESTR_DEMO_SETUP_URL,
    env.ORKESTR_SETUP_URL,
    `http://127.0.0.1:${firstValue(env.ORKESTR_PORT, env.PORT, "3000")}/setup`,
  );
}

function demoInternalUrl(env = process.env) {
  return `http://127.0.0.1:${firstValue(env.ORKESTR_PORT, env.PORT, "3000")}`;
}

function publicSetupUrlOverride(env = process.env) {
  return firstValue(env.ORKESTR_DEMO_PUBLIC_SETUP_URL, env.ORKESTR_DEMO_SETUP_PUBLIC_URL);
}

function publicBaseUrlOverride(env = process.env) {
  return firstValue(
    env.ORKESTR_DEMO_PUBLIC_BASE_URL,
    env.ORKESTR_PUBLIC_HTTPS_URL,
    env.ORKESTR_HTTPS_URL,
    env.ORKESTR_TAILSCALE_HTTPS_NAME,
  );
}

function healthUrl(env = process.env) {
  return firstValue(
    env.ORKESTR_DEMO_INTERNAL_HEALTH_URL,
    `http://127.0.0.1:${firstValue(env.ORKESTR_PORT, env.PORT, "3000")}/api/health`,
  );
}

function statePath(env = process.env) {
  return firstValue(
    env.ORKESTR_DEMO_NOTIFY_STATE_PATH,
    path.join(firstValue(env.ORKESTR_HOME, "/data"), "demo-vm-ready-notification.json"),
  );
}

function relayUrl(env = process.env) {
  return firstValue(env.ORKESTR_DEMO_WHATSAPP_RELAY_URL, env.WHATSAPP_BRIDGE_URL);
}

function relayToken(env = process.env) {
  return firstValue(env.ORKESTR_DEMO_WHATSAPP_RELAY_TOKEN, env.WHATSAPP_BRIDGE_TOKEN, env.WA_HTTP_TOKEN);
}

function relayAccountId(env = process.env) {
  return firstValue(
    env.ORKESTR_DEMO_WHATSAPP_RELAY_ACCOUNT_ID,
    env.ORKESTR_WHATSAPP_RESPONDER_ACCOUNT_ID,
    env.ORKESTR_WHATSAPP_ACCOUNT_ID,
    "responder",
  );
}

function positiveTimeoutMs(value, fallback) {
  const text = clean(value);
  if (!text) return fallback;
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.floor(parsed));
}

export function readyMessage({ setupUrl }) {
  return [
    "Orkestr demo VM is ready.",
    "",
    "Please open this challenge-gated setup link and complete Codex login/sign-in:",
    setupUrl,
    "",
    "Steps:",
    "1. Complete Codex login/sign-in in setup.",
    "2. Keep WhatsApp on Orkestr relay, or switch to your own relay.",
    "3. Start the orkest thread.",
    "",
    "Orkestr will show a temporary browser-pairing challenge before setup opens.",
  ].join("\n");
}

function cloudflareTunnelStatePath(env = process.env) {
  return firstValue(
    env.ORKESTR_DEMO_CLOUDFLARE_STATE_PATH,
    path.join(firstValue(env.ORKESTR_HOME, "/data"), "demo-cloudflare-tunnel.json"),
  );
}

function processAlive(pid) {
  const parsed = Number(pid);
  if (!Number.isInteger(parsed) || parsed <= 0) return false;
  try {
    process.kill(parsed, 0);
    return true;
  } catch {
    return false;
  }
}

function cloudflareQuickTunnelUrl(text = "") {
  return clean(text).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i)?.[0] || "";
}

async function writeCloudflareTunnelState(filePath, payload) {
  await writeJson(filePath, {
    schemaVersion: 1,
    ...payload,
    updatedAt: new Date().toISOString(),
  });
}

async function ensureCloudflareQuickTunnel(env = process.env, options = {}) {
  if (truthy(env.ORKESTR_DEMO_CLOUDFLARE_DISABLE)) {
    return { ok: false, reason: "cloudflare_tunnel_disabled" };
  }
  if (!truthy(env.ORKESTR_DEMO_CLOUDFLARE_FALLBACK) && !truthy(env.ORKESTR_DEMO_CLOUDFLARE_ENABLE)) {
    return { ok: false, reason: "cloudflare_tunnel_not_enabled" };
  }
  const filePath = cloudflareTunnelStatePath(env);
  const target = firstValue(env.ORKESTR_DEMO_TUNNEL_TARGET_URL, demoInternalUrl(env));
  const prior = await readJson(filePath, {});
  if (prior.url && prior.target === target && processAlive(prior.pid)) {
    return { ok: true, url: clean(prior.url), reused: true, pid: Number(prior.pid), statePath: filePath };
  }

  const command = firstValue(env.ORKESTR_CLOUDFLARED_BIN, "cloudflared");
  const timeoutMs = positiveTimeoutMs(env.ORKESTR_DEMO_CLOUDFLARE_TIMEOUT_MS, 45_000);
  const spawnImpl = options.spawnImpl || spawn;
  const child = spawnImpl(command, ["tunnel", "--url", target, "--no-autoupdate"], {
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (!child || !child.stdout || !child.stderr) {
    return { ok: false, reason: "cloudflare_tunnel_spawn_failed", statePath: filePath };
  }

  return await new Promise((resolve) => {
    let settled = false;
    let output = "";
    const finish = async (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (result.ok && typeof child.unref === "function") child.unref();
      if (result.ok && child.stdout?.unref) child.stdout.unref();
      if (result.ok && child.stderr?.unref) child.stderr.unref();
      await writeCloudflareTunnelState(filePath, result.ok
        ? { state: "ready", url: result.url, pid: child.pid || null, target }
        : { state: "blocked", reason: result.reason, pid: child.pid || null, target });
      resolve({ ...result, pid: child.pid || null, statePath: filePath });
    };
    const onData = (chunk) => {
      output += String(chunk || "");
      const url = cloudflareQuickTunnelUrl(output);
      if (url) void finish({ ok: true, url });
    };
    const timer = setTimeout(() => {
      if (typeof child.kill === "function") child.kill("SIGTERM");
      void finish({ ok: false, reason: "cloudflare_tunnel_timeout" });
    }, timeoutMs);
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (error) => void finish({ ok: false, reason: error?.code === "ENOENT" ? "cloudflared_not_found" : "cloudflare_tunnel_error" }));
    child.on("exit", (code) => {
      if (!settled) void finish({ ok: false, reason: `cloudflare_tunnel_exited_${code ?? "unknown"}` });
    });
  });
}

export async function demoPublicSetupUrl(env = process.env, options = {}) {
  const registration = await demoBrokerRegistration(env, options);
  if (!registration.ok || !registration.instanceId) {
    return {
      ok: false,
      reason: registration.reason || "broker_registration_unavailable",
      registration,
    };
  }
  const instanceId = normalizeInstanceId(registration.instanceId);
  const explicitSetup = publicSetupUrlOverride(env);
  if (explicitSetup) {
    if (isLocalUrl(explicitSetup) && !truthy(env.ORKESTR_DEMO_ALLOW_LOCAL_SETUP_URL)) {
      return { ok: false, reason: "public_setup_url_is_local" };
    }
    return { ok: true, setupUrl: setupUrlWithInstanceId(explicitSetup, instanceId), source: "public_setup_url", instanceId, registration };
  }

  const legacySetup = demoSetupUrl(env);
  const publicBase = publicBaseUrlOverride(env);
  if (publicBase) {
    const setupUrl = pairingSetupUrl(publicBase, { returnTo: setupReturnPathFromUrl(legacySetup) || "/setup", instanceId });
    if (setupUrl) return { ok: true, setupUrl, source: "public_base_url", instanceId, registration };
  }

  if (legacySetup && !isLocalUrl(legacySetup)) {
    const setupUrl = pairingSetupUrl(legacySetup, { returnTo: setupReturnPathFromUrl(legacySetup), instanceId });
    if (setupUrl) return { ok: true, setupUrl, source: "external_setup_url", instanceId, registration };
  }

  const tunnel = await ensureCloudflareQuickTunnel(env, options);
  if (tunnel.ok && tunnel.url) {
    const setupUrl = pairingSetupUrl(tunnel.url, { returnTo: setupReturnPathFromUrl(legacySetup) || "/setup", instanceId });
    return { ok: true, setupUrl, source: tunnel.reused ? "cloudflare_reused" : "cloudflare_quick_tunnel", tunnel, instanceId, registration };
  }

  if (truthy(env.ORKESTR_DEMO_ALLOW_LOCAL_SETUP_URL)) {
    return { ok: true, setupUrl: setupUrlWithInstanceId(legacySetup, instanceId), source: "local_unsafe_fallback", instanceId, registration };
  }

  return { ok: false, reason: tunnel.reason || "public_setup_url_unavailable", tunnel };
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function request(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 5000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => body += chunk);
      res.on("end", () => resolve({ statusCode: res.statusCode, body }));
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("health_request_timeout")));
  });
}

async function waitForHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await request(url);
      if (response.statusCode === 200 && /orkestr/i.test(response.body)) return response;
      lastError = new Error(`unexpected_health:${response.statusCode}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw lastError || new Error("health_timeout");
}

export async function runDemoVmReadyNotify(env = process.env, options = {}) {
  if (truthy(env.ORKESTR_DEMO_NOTIFY_DISABLE)) return { ok: true, skipped: true, reason: "disabled" };
  const phoneNumber = firstValue(env.ORKESTR_DEMO_WHATSAPP_NUMBER, env.ORKESTR_DEMO_WA_NUMBER);
  if (!phoneNumber) return { ok: true, skipped: true, reason: "missing_demo_whatsapp_number" };
  const chatId = normalizeWhatsAppChatId(phoneNumber);
  if (!chatId) return { ok: false, skipped: true, reason: "invalid_demo_whatsapp_number" };
  const filePath = statePath(env);
  const chatHash = sha256(chatId);
  const prior = await readJson(filePath, {});
  if (!truthy(env.ORKESTR_DEMO_NOTIFY_FORCE) && prior.sent === true && prior.chatHash === chatHash) {
    return { ok: true, skipped: true, reason: "already_sent", statePath: filePath };
  }

  const publicSetup = await demoPublicSetupUrl(env, options);
  if (!publicSetup.ok || !publicSetup.setupUrl) {
    await writeJson(filePath, {
      schemaVersion: 1,
      sent: false,
      state: "blocked",
      reason: publicSetup.reason || "public_setup_url_unavailable",
      instanceId: publicSetup.instanceId || "",
      tunnel: publicSetup.tunnel || null,
      updatedAt: new Date().toISOString(),
    });
    return { ok: false, skipped: true, reason: publicSetup.reason || "public_setup_url_unavailable", statePath: filePath };
  }
  const setupUrl = publicSetup.setupUrl;
  const targetKey = sha256(`${chatId}|${setupUrl}`);
  if (!truthy(env.ORKESTR_DEMO_NOTIFY_FORCE) && prior.sent === true && prior.targetKey === targetKey) {
    return { ok: true, skipped: true, reason: "already_sent", statePath: filePath };
  }

  await writeRuntimeSettings({
    connectors: {
      whatsapp: {
        enabled: true,
        accessMode: "relay",
        bridgeMode: "relay",
      },
    },
  }, env);

  const bridgeUrl = relayUrl(env);
  if (!bridgeUrl) {
    await writeJson(filePath, {
      schemaVersion: 1,
      sent: false,
      targetKey,
      chatHash,
      state: "blocked",
      reason: "relay_bridge_url_missing",
      setupUrl,
      instanceId: publicSetup.instanceId || "",
      updatedAt: new Date().toISOString(),
    });
    return { ok: false, skipped: true, reason: "relay_bridge_url_missing", statePath: filePath };
  }

  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl,
    ...(relayToken(env) ? { apiToken: relayToken(env) } : {}),
  }, env);

  const timeoutMs = positiveTimeoutMs(env.ORKESTR_DEMO_NOTIFY_HEALTH_TIMEOUT_MS, 120_000);
  if (timeoutMs) await waitForHealth(healthUrl(env), timeoutMs);

  const text = readyMessage({ setupUrl });
  const sendEnv = {
    ...env,
    WHATSAPP_BRIDGE_MODE: "external",
    ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED: "1",
    WHATSAPP_BRIDGE_URL: bridgeUrl,
    ...(relayToken(env) ? { WHATSAPP_BRIDGE_TOKEN: relayToken(env) } : {}),
  };
  const result = await sendWhatsAppText({
    chatId,
    text,
    accountId: relayAccountId(env),
    config: { bridgeMode: "external", bridgeUrl, ...(relayToken(env) ? { apiToken: relayToken(env) } : {}) },
    env: sendEnv,
    fetchImpl: options.fetchImpl || fetch,
  });

  await writeJson(filePath, {
    schemaVersion: 1,
    sent: true,
    targetKey,
    chatHash,
    state: "sent",
    setupUrl,
    setupUrlSource: publicSetup.source || "",
    instanceId: publicSetup.instanceId || "",
    tunnel: publicSetup.tunnel ? {
      url: publicSetup.tunnel.url || "",
      pid: publicSetup.tunnel.pid || null,
      reused: publicSetup.tunnel.reused === true,
    } : null,
    result: {
      ok: result?.ok !== false,
      ids: Array.isArray(result?.ids) ? result.ids : undefined,
      sentCount: Array.isArray(result?.sent) ? result.sent.length : undefined,
    },
    updatedAt: new Date().toISOString(),
  });
  return { ok: true, sent: true, statePath: filePath };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runDemoVmReadyNotify()
    .then((result) => {
      console.log(JSON.stringify(result));
      if (result.ok === false && result.reason !== "relay_bridge_url_missing") process.exitCode = 1;
    })
    .catch((error) => {
      console.error(JSON.stringify({ ok: false, error: error?.message || String(error) }));
      process.exitCode = 1;
    });
}
