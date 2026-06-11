#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { sendWhatsAppText } from "../packages/connectors/src/whatsapp.js";
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

function readyMessage({ setupUrl }) {
  return [
    "Orkestr demo VM is ready.",
    "",
    "Open setup through your VM-local browser, SSH tunnel, or port forward:",
    setupUrl,
    "",
    "Steps:",
    "1. Connect Codex and finish the Codex sign-in.",
    "2. Keep WhatsApp on Orkestr relay, or switch to your own relay.",
    "3. Start the orkest thread.",
    "",
    "No public app URL is required for this demo.",
  ].join("\n");
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

  const setupUrl = demoSetupUrl(env);
  const targetKey = sha256(`${chatId}|${setupUrl}`);
  const filePath = statePath(env);
  const prior = await readJson(filePath, {});
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
      state: "blocked",
      reason: "relay_bridge_url_missing",
      setupUrl,
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
    state: "sent",
    setupUrl,
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
