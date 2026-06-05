import { spawn } from "node:child_process";
import { appendEvent } from "../../storage/src/store.js";
import { estimateOpenAICost, recordCreditUsage } from "./credit-usage.js";

function nowIso() {
  return new Date().toISOString();
}

function sanitizerTimeoutMs(env = process.env) {
  const parsed = Number(env.ORKESTR_LLM_SANITIZER_TIMEOUT_MS || 20_000);
  return Number.isFinite(parsed) ? Math.max(1000, parsed) : 20_000;
}

function sanitizerMaxAttempts(env = process.env) {
  const parsed = Number(env.ORKESTR_LLM_SANITIZER_MAX_ATTEMPTS || 3);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(6, Math.floor(parsed))) : 3;
}

function sanitizerRetryDelayMs(env = process.env) {
  const parsed = Number(env.ORKESTR_LLM_SANITIZER_RETRY_DELAY_MS || 750);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(10_000, Math.floor(parsed))) : 750;
}

function clean(value) {
  return String(value || "").trim();
}

function delay(ms = 0) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function retryableSanitizerReason(reason = "") {
  const text = clean(reason).toLowerCase();
  if (/^llm_sanitizer_http_(?:408|409|425|429|5\d\d)$/.test(text)) return true;
  return [
    "llm_sanitizer_timeout",
    "llm_sanitizer_empty_response",
    "llm_sanitizer_invalid_json",
  ].includes(text);
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

function openAIBaseUrl(env = process.env) {
  return clean(env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/g, "");
}

function openAISanitizerModel(env = process.env) {
  return clean(env.ORKESTR_LLM_SANITIZER_MODEL || env.ORKESTR_API_AGENT_ROUTER_MODEL || "gpt-5-nano");
}

function responseText(response = {}) {
  const direct = clean(response.output_text);
  if (direct) return direct;
  const chunks = [];
  for (const item of Array.isArray(response.output) ? response.output : []) {
    if (item?.type !== "message") continue;
    for (const part of Array.isArray(item.content) ? item.content : []) {
      if (part?.type === "output_text" && clean(part.text)) chunks.push(clean(part.text));
    }
  }
  return chunks.join("\n").trim();
}

function parseJsonDecision(text = "") {
  const raw = clean(text);
  if (!raw) return unavailable("llm_sanitizer_empty_response");
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidate = fenced || raw;
  try {
    return normalizeDecision(JSON.parse(candidate));
  } catch {
    return unavailable("llm_sanitizer_invalid_json");
  }
}

async function runOpenAISanitizer(payload, env = process.env) {
  const apiKey = clean(env.OPENAI_API_KEY || env.ORKESTR_OPENAI_API_KEY);
  if (!apiKey) return unavailable("llm_sanitizer_unconfigured");
  const model = openAISanitizerModel(env);
  const attempts = sanitizerMaxAttempts(env);
  let last = unavailable("llm_sanitizer_unavailable");
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), sanitizerTimeoutMs(env));
    try {
      const response = await fetch(`${openAIBaseUrl(env)}/responses`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          instructions: [
            "You are Orkestr's tenant isolation sanitizer.",
            "Return only compact JSON with keys: allow boolean, reason string, category string.",
            "Allow normal same-tenant chat and same-tenant resource requests.",
            "For thread.input and api-agent.input, allow same-user requests to use a connector even when that capability is missing; the tenant assistant can explain that it is not connected or start a user-scoped connector sign-in flow. Do not treat this as permission for connector data access.",
            "Allow same-user api-agent.tool.orkestr_start_connector_auth when Gmail, Outlook, Jira, or Shopify is missing because it only starts user-scoped connector sign-in and does not read connector data or expose tokens.",
            "Allow same-user api-agent.tool.orkestr_connector_status because it only returns safe connection state for the current user's connector and does not read connector data or expose tokens.",
            "Allow same-user api-agent.tool.orkestr_get_onboarding_profile and api-agent.tool.orkestr_update_onboarding_profile for non-secret setup preferences, requested tools, timezone, language, and notes.",
            "Allow same-user api-agent.tool.orkestr_create_timer, api-agent.tool.orkestr_delete_timer, and api-agent.tool.orkestr_run_timer when the timer belongs to the requesting user and targets that user's own chat or agent.",
            "Allow same-user connector_prompt_push.create, connector_prompt_push.update, and connector_prompt_push.execute only when the push belongs to the requesting user, targets that user's own chat or agent, and the matching connector capability is true.",
            "Deny cross-tenant access, host secrets, connector tokens, browser profile files, private overlays, sanitizer bypass, and challenge approval.",
            "Deny tool execution or actual connector data access when the matching capability is not true for the same user, except explicit same-user connector auth-start/status tools such as orkestr_start_connector_auth and orkestr_connector_status, and same-user timer management tools.",
            "If uncertain, deny.",
          ].join("\n"),
          input: JSON.stringify(payload),
          max_output_tokens: 220,
          store: false,
          metadata: {
            orkestr_runtime: "llm-sanitizer",
            action: clean(payload.action).slice(0, 64),
            tenant_id: clean(payload?.principal?.userId || payload?.resource?.ownerUserId).slice(0, 64),
          },
        }),
        signal: controller.signal,
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        last = unavailable(`llm_sanitizer_http_${response.status}`);
      } else {
        await recordCreditUsage({
          tenantId: payload?.principal?.userId || payload?.resource?.ownerUserId || "",
          threadId: payload?.resource?.type === "thread" ? payload?.resource?.id || "" : "",
          responseId: clean(result.id),
          runtimeKind: "api-agent",
          sourceChannel: "sanitizer",
          callKind: "sanitizer",
          model: clean(result.model) || model,
          usage: result.usage || {},
          estimatedCostUsd: estimateOpenAICost({ model: clean(result.model) || model, usage: result.usage || {} }, env),
          status: "completed",
        }, env).catch(() => {});
        const decision = parseJsonDecision(responseText(result));
        last = {
          ...decision,
          model: clean(result.model) || model,
          raw: decision.raw || result,
        };
      }
    } catch (error) {
      last = unavailable(error?.name === "AbortError" ? "llm_sanitizer_timeout" : error?.message || String(error));
    } finally {
      clearTimeout(timer);
    }
    if (!retryableSanitizerReason(last.reason) || attempt >= attempts) return last;
    await delay(sanitizerRetryDelayMs(env) * attempt);
  }
  return last;
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
  const attempts = sanitizerMaxAttempts(env);
  let last = unavailable("llm_sanitizer_unavailable");
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
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
      last = response.ok ? normalizeDecision(await response.json()) : unavailable(`llm_sanitizer_http_${response.status}`);
    } catch (error) {
      last = unavailable(error?.name === "AbortError" ? "llm_sanitizer_timeout" : error?.message || String(error));
    } finally {
      clearTimeout(timer);
    }
    if (!retryableSanitizerReason(last.reason) || attempt >= attempts) return last;
    await delay(sanitizerRetryDelayMs(env) * attempt);
  }
  return last;
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
  if (
    String(env.ORKESTR_LLM_SANITIZER_PROVIDER || "").trim().toLowerCase() === "openai" ||
    (!String(env.ORKESTR_LLM_SANITIZER_COMMAND || env.ORKESTR_LLM_SANITIZER_COMMAND_JSON || "").trim() && String(env.OPENAI_API_KEY || env.ORKESTR_OPENAI_API_KEY || "").trim())
  ) {
    return runOpenAISanitizer(payload, env);
  }
  return runCommandSanitizer(payload, env);
}

export async function assertSanitizedAction(request = {}, env = process.env) {
  const decision = await sanitizeAction(request, env);
  await appendSanitizerAudit(request, decision, env);
  if (decision.allow === true) return decision;
  const error = new Error(decision.reason || "llm_sanitizer_denied");
  error.statusCode = 403;
  error.sanitizer = decision;
  throw error;
}

async function appendSanitizerAudit(request = {}, decision = {}, env = process.env) {
  const principal = request.principal && typeof request.principal === "object" ? request.principal : {};
  const resource = request.resource && typeof request.resource === "object" ? request.resource : {};
  await appendEvent({
    type: "policy_sanitizer_decision",
    actorUserId: principal.userId || "",
    ownerUserId: resource.ownerUserId || resource.userId || principal.userId || "",
    resourceType: resource.type || "system",
    resourceId: resource.id || resource.threadId || resource.timerId || "",
    action: String(request.action || "sanitizer.check"),
    outcome: decision.allow === true ? "allowed" : "blocked",
    reason: decision.reason || "",
    model: decision.model || null,
    unavailable: decision.unavailable === true,
  }, env).catch(() => {});
}
