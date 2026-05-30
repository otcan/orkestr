import { spawn } from "node:child_process";

function nowIso() {
  return new Date().toISOString();
}

function sanitizerTimeoutMs(env = process.env) {
  const parsed = Number(env.ORKESTR_LLM_SANITIZER_TIMEOUT_MS || 20_000);
  return Number.isFinite(parsed) ? Math.max(1000, parsed) : 20_000;
}

function parseCommand(env = process.env) {
  const json = String(env.ORKESTR_LLM_SANITIZER_COMMAND_JSON || "").trim();
  if (json) {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed) || !parsed.length) throw new Error("llm_sanitizer_command_invalid");
    return parsed.map((item) => String(item));
  }
  const raw = String(env.ORKESTR_LLM_SANITIZER_COMMAND || "").trim();
  if (!raw) return [];
  return raw.split(/\s+/g).filter(Boolean);
}

function normalizeDecision(value = {}) {
  const unavailable = value.unavailable === true;
  const explicitAllow = value.allow === true;
  const explicitDeny = value.allow === false;
  const textDecision = String(value.decision || value.result || "").trim().toLowerCase();
  const allow = !unavailable && (explicitAllow || (!explicitDeny && textDecision === "allow"));
  const reason = String(value.reason || value.message || (allow ? "allowed" : "denied")).trim();
  return {
    allow,
    reason,
    model: String(value.model || value.provider || "").trim() || null,
    raw: value,
    unavailable,
  };
}

function unavailable(reason) {
  return {
    allow: false,
    reason,
    model: null,
    raw: null,
    unavailable: true,
  };
}

async function runCommandSanitizer(payload, env = process.env) {
  let command = [];
  try {
    command = parseCommand(env);
  } catch {
    return unavailable("llm_sanitizer_command_invalid");
  }
  if (!command.length) return unavailable("llm_sanitizer_unconfigured");
  const [file, ...args] = command;
  const timeoutMs = sanitizerTimeoutMs(env);
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (decision) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.unref?.();
      child.stdin.unref?.();
      child.stdout.unref?.();
      child.stderr.unref?.();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      resolve(decision);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(unavailable("llm_sanitizer_timeout"));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      finish(unavailable(error?.code === "ENOENT" ? "llm_sanitizer_command_missing" : error?.message || String(error)));
    });
    child.on("close", (code) => {
      if (code !== 0) {
        finish(normalizeDecision({ allow: false, reason: stderr.trim() || `llm_sanitizer_exit_${code}` }));
        return;
      }
      try {
        finish(normalizeDecision(JSON.parse(stdout || "{}")));
      } catch {
        finish(unavailable("llm_sanitizer_invalid_json"));
      }
    });
    child.stdin.end(`${JSON.stringify(payload)}\n`);
  });
}

async function runHttpSanitizer(payload, env = process.env) {
  const url = String(env.ORKESTR_LLM_SANITIZER_URL || "").trim();
  if (!url) return unavailable("llm_sanitizer_unconfigured");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), sanitizerTimeoutMs(env));
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(env.ORKESTR_LLM_SANITIZER_TOKEN ? { authorization: `Bearer ${env.ORKESTR_LLM_SANITIZER_TOKEN}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) return unavailable(`llm_sanitizer_http_${response.status}`);
    return normalizeDecision(await response.json());
  } catch (error) {
    return unavailable(error?.name === "AbortError" ? "llm_sanitizer_timeout" : error?.message || String(error));
  } finally {
    clearTimeout(timer);
  }
}

export async function sanitizeAction(request = {}, env = process.env) {
  const payload = {
    schemaVersion: 1,
    requestedAt: nowIso(),
    action: String(request.action || "").trim(),
    principal: request.principal || null,
    resource: request.resource || null,
    input: request.input || null,
    policy: {
      llmOnly: true,
      failClosed: true,
    },
  };
  if (String(env.ORKESTR_LLM_SANITIZER_URL || "").trim()) {
    return runHttpSanitizer(payload, env);
  }
  return runCommandSanitizer(payload, env);
}

export async function assertSanitizedAction(request = {}, env = process.env) {
  const decision = await sanitizeAction(request, env);
  if (decision.allow === true) return decision;
  const error = new Error(decision.reason || "llm_sanitizer_denied");
  error.statusCode = 403;
  error.sanitizer = decision;
  throw error;
}
