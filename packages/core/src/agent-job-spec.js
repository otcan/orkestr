// Agent Job spec v0: strict validator and normalizer (no execution).
// Spec: docs/spec/agent-job.md. Input is a plain object (parsed JSON or YAML);
// see agent-job-spec-yaml.js for the YAML entry point.

export const AGENT_JOB_API_VERSION = "orkestr/v0";
export const AGENT_JOB_KIND = "AgentJob";
export const AGENT_JOB_PROVIDERS = Object.freeze(["simulated", "codex", "claude-code", "openai-compatible"]);
export const AGENT_JOB_TRIGGER_TYPES = Object.freeze(["schedule", "webhook", "api"]);
export const AGENT_JOB_SCHEDULE_CADENCES = Object.freeze(["interval", "daily", "weekly"]);
export const AGENT_JOB_CONCURRENCY = Object.freeze(["forbid", "queue", "replace"]);
export const AGENT_JOB_BACKOFF = Object.freeze(["fixed", "exponential"]);
export const AGENT_JOB_NOTIFY_EVENTS = Object.freeze([
  "succeeded",
  "failed",
  "retrying",
  "cancelled",
  "approval_required",
  "approval_expired",
]);
export const AGENT_JOB_NOTIFY_CHANNELS = Object.freeze(["thread", "webhook", "email", "whatsapp"]);

const NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const LABEL_KEY_RE = /^[a-z0-9]([a-z0-9._/-]{0,61}[a-z0-9])?$/;
const TOOL_RE = /^[a-z0-9_-]+(\.[a-z0-9_-]+)*(\.\*)?$|^\*$/;
const SECRET_REF_RE = /^vault:\/\/[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const CLOCK_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DURATION_RE = /^(\d+)(ms|s|m|h|d)$/;
const JSON_POINTER_RE = /^(\/[^/]*)+$/;
const DURATION_UNITS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const MAX_PROMPT_CHARS = 32_000;
const MAX_ATTEMPTS_LIMIT = 20;
const MAX_FALLBACKS = 3;

export class AgentJobSpecError extends Error {
  constructor(errors) {
    super(`invalid_agent_job_spec: ${errors.map((e) => `${e.path} ${e.code}`).join("; ")}`);
    this.name = "AgentJobSpecError";
    this.code = "invalid_agent_job_spec";
    this.statusCode = 400;
    this.errors = errors;
  }
}

export function parseDurationMs(value) {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  const match = typeof value === "string" ? value.trim().match(DURATION_RE) : null;
  if (!match) return null;
  return Number(match[1]) * DURATION_UNITS[match[2]];
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function createContext() {
  const errors = [];
  return {
    errors,
    fail(path, code, message) {
      errors.push({ path, code, message });
    },
  };
}

function checkKeys(ctx, value, path, allowed) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) ctx.fail(`${path}.${key}`, "unknown_field", `unknown field "${key}"`);
  }
}

function objectAt(ctx, value, path, allowed, { required = true } = {}) {
  if (value === undefined && !required) return null;
  if (!isPlainObject(value)) {
    ctx.fail(path, value === undefined ? "required" : "invalid_type", "expected an object");
    return null;
  }
  checkKeys(ctx, value, path, allowed);
  return value;
}

function stringAt(ctx, value, path, { required = true, pattern, max = 512, oneOf } = {}) {
  if (value === undefined || value === null) {
    if (required) ctx.fail(path, "required", "required string");
    return undefined;
  }
  if (typeof value !== "string" || !value.trim()) {
    ctx.fail(path, "invalid_type", "expected a non-empty string");
    return undefined;
  }
  const text = value.trim();
  if (text.length > max) ctx.fail(path, "too_long", `longer than ${max} characters`);
  else if (oneOf && !oneOf.includes(text)) ctx.fail(path, "invalid_value", `expected one of ${oneOf.join(", ")}`);
  else if (pattern && !pattern.test(text)) ctx.fail(path, "invalid_format", `does not match ${pattern}`);
  else return text;
  return undefined;
}

function durationAt(ctx, value, path, fallback, { min = 0 } = {}) {
  if (value === undefined) return fallback;
  const ms = parseDurationMs(value);
  if (ms === null) {
    ctx.fail(path, "invalid_duration", "expected a duration like 30s, 10m, 2h or 1d");
    return fallback;
  }
  if (ms < min) {
    ctx.fail(path, "out_of_range", `must be at least ${min}ms`);
    return fallback;
  }
  return ms;
}

function integerAt(ctx, value, path, fallback, { min, max }) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    ctx.fail(path, "out_of_range", `expected an integer between ${min} and ${max}`);
    return fallback;
  }
  return value;
}

function stringListAt(ctx, value, path, { pattern, oneOf, unique = true } = {}) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    ctx.fail(path, "invalid_type", "expected a list");
    return [];
  }
  const out = [];
  value.forEach((entry, index) => {
    const text = stringAt(ctx, entry, `${path}[${index}]`, { pattern, oneOf });
    if (text === undefined) return;
    if (unique && out.includes(text)) ctx.fail(`${path}[${index}]`, "duplicate", `duplicate "${text}"`);
    else out.push(text);
  });
  return out;
}

function normalizeMetadata(ctx, value) {
  const meta = objectAt(ctx, value, "metadata", ["name", "description", "labels"]);
  if (!meta) return { name: undefined, description: "", labels: {} };
  const labels = {};
  const rawLabels = objectAt(ctx, meta.labels, "metadata.labels", Object.keys(meta.labels || {}), { required: false });
  for (const [key, label] of Object.entries(rawLabels || {})) {
    if (!LABEL_KEY_RE.test(key)) ctx.fail(`metadata.labels.${key}`, "invalid_format", "invalid label key");
    const text = stringAt(ctx, label, `metadata.labels.${key}`, { max: 63 });
    if (text !== undefined) labels[key] = text;
  }
  return {
    name: stringAt(ctx, meta.name, "metadata.name", { pattern: NAME_RE, max: 63 }),
    description: stringAt(ctx, meta.description, "metadata.description", { required: false, max: 1000 }) || "",
    labels,
  };
}

function normalizeTrigger(ctx, raw, path) {
  if (!isPlainObject(raw)) {
    ctx.fail(path, "invalid_type", "expected an object");
    return null;
  }
  const type = stringAt(ctx, raw.type, `${path}.type`, { oneOf: AGENT_JOB_TRIGGER_TYPES });
  if (type === "schedule") {
    checkKeys(ctx, raw, path, ["type", "cadence", "every", "time", "timezone"]);
    const cadence = stringAt(ctx, raw.cadence, `${path}.cadence`, { oneOf: AGENT_JOB_SCHEDULE_CADENCES });
    const trigger = { type, cadence };
    if (cadence === "interval") {
      if (raw.time !== undefined) ctx.fail(`${path}.time`, "not_allowed", "time is only valid for daily/weekly");
      trigger.everyMs = durationAt(ctx, raw.every, `${path}.every`, undefined, { min: 60_000 });
      if (raw.every === undefined) ctx.fail(`${path}.every`, "required", "interval schedules need every");
    } else if (cadence) {
      if (raw.every !== undefined) ctx.fail(`${path}.every`, "not_allowed", "every is only valid for interval");
      trigger.time = stringAt(ctx, raw.time, `${path}.time`, { pattern: CLOCK_RE });
    }
    trigger.timezone = stringAt(ctx, raw.timezone, `${path}.timezone`, { required: false, max: 64 }) || "UTC";
    return trigger;
  }
  if (type === "webhook") {
    checkKeys(ctx, raw, path, ["type", "name", "secret_ref", "event_id"]);
    return {
      type,
      name: stringAt(ctx, raw.name, `${path}.name`, { pattern: NAME_RE, max: 63 }),
      secretRef: stringAt(ctx, raw.secret_ref, `${path}.secret_ref`, { pattern: SECRET_REF_RE }),
      eventId: stringAt(ctx, raw.event_id, `${path}.event_id`, { required: false, pattern: JSON_POINTER_RE }) || null,
    };
  }
  if (type === "api") {
    checkKeys(ctx, raw, path, ["type"]);
    return { type };
  }
  return null;
}

function normalizeTriggers(ctx, value) {
  if (!Array.isArray(value) || value.length === 0) {
    ctx.fail("triggers", value === undefined ? "required" : "invalid_type", "expected a non-empty list");
    return [];
  }
  const triggers = value.map((raw, index) => normalizeTrigger(ctx, raw, `triggers[${index}]`)).filter(Boolean);
  const webhookNames = new Set();
  triggers.forEach((trigger, index) => {
    if (trigger.type !== "webhook" || !trigger.name) return;
    if (webhookNames.has(trigger.name)) ctx.fail(`triggers[${index}].name`, "duplicate", "duplicate webhook name");
    webhookNames.add(trigger.name);
  });
  if (triggers.filter((t) => t.type === "api").length > 1) ctx.fail("triggers", "duplicate", "at most one api trigger");
  return triggers;
}

// `agent` has already been key-checked by normalizeAgent; fallback entries have not.
function normalizeProviderRef(ctx, raw, path, { checked = false } = {}) {
  const ref = objectAt(ctx, raw, path, checked ? Object.keys(raw) : ["provider", "model", "base_url"]);
  if (!ref) return null;
  const provider = stringAt(ctx, ref.provider, `${path}.provider`, { oneOf: AGENT_JOB_PROVIDERS });
  const out = { provider, model: stringAt(ctx, ref.model, `${path}.model`, { required: false, max: 128 }) || null };
  if (provider === "openai-compatible") {
    if (!out.model) ctx.fail(`${path}.model`, "required", "openai-compatible providers need a model");
    out.baseUrl = stringAt(ctx, ref.base_url, `${path}.base_url`, { pattern: /^https?:\/\/\S+$/, max: 512 });
  } else if (ref.base_url !== undefined) {
    ctx.fail(`${path}.base_url`, "not_allowed", "base_url is only valid for openai-compatible");
  }
  return out;
}

function normalizeAgent(ctx, value) {
  const agent = objectAt(ctx, value, "agent", ["provider", "model", "base_url", "fallback"]);
  if (!agent) return null;
  const { fallback, ...primaryRaw } = agent;
  const primary = normalizeProviderRef(ctx, primaryRaw, "agent", { checked: true });
  const fallbacks = [];
  if (fallback !== undefined) {
    if (!Array.isArray(fallback)) ctx.fail("agent.fallback", "invalid_type", "expected a list");
    else if (fallback.length > MAX_FALLBACKS) ctx.fail("agent.fallback", "too_many", `at most ${MAX_FALLBACKS} fallbacks`);
    else {
      const seen = new Set([`${primary?.provider}|${primary?.model}`]);
      fallback.forEach((raw, index) => {
        const ref = normalizeProviderRef(ctx, raw, `agent.fallback[${index}]`);
        if (!ref) return;
        const key = `${ref.provider}|${ref.model}`;
        if (seen.has(key)) ctx.fail(`agent.fallback[${index}]`, "duplicate", "repeats an earlier provider/model");
        seen.add(key);
        fallbacks.push(ref);
      });
    }
  }
  return { ...primary, fallback: fallbacks };
}

function normalizeTask(ctx, value) {
  const task = objectAt(ctx, value, "task", ["prompt", "inputs", "output_schema"]);
  if (!task) return null;
  const inputs = task.inputs === undefined ? {} : task.inputs;
  if (!isPlainObject(inputs)) ctx.fail("task.inputs", "invalid_type", "expected an object");
  const outputSchema = task.output_schema === undefined ? null : task.output_schema;
  if (outputSchema !== null && !isPlainObject(outputSchema)) {
    ctx.fail("task.output_schema", "invalid_type", "expected a JSON Schema object");
  }
  return {
    prompt: stringAt(ctx, task.prompt, "task.prompt", { max: MAX_PROMPT_CHARS }),
    inputs: isPlainObject(inputs) ? structuredClone(inputs) : {},
    outputSchema: isPlainObject(outputSchema) ? structuredClone(outputSchema) : null,
  };
}

function toolMatches(pattern, tool) {
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) return tool === pattern.slice(0, -2) || tool.startsWith(pattern.slice(0, -1));
  return pattern === tool;
}

function normalizePermissions(ctx, value) {
  const perms = objectAt(ctx, value, "permissions", ["tools", "secrets"], { required: false });
  const tools = objectAt(ctx, perms?.tools, "permissions.tools", ["allow", "deny", "approval_required"], {
    required: false,
  });
  const allow = stringListAt(ctx, tools?.allow, "permissions.tools.allow", { pattern: TOOL_RE });
  const deny = stringListAt(ctx, tools?.deny, "permissions.tools.deny", { pattern: TOOL_RE });
  const approvalRequired = stringListAt(ctx, tools?.approval_required, "permissions.tools.approval_required", {
    pattern: TOOL_RE,
  });
  approvalRequired.forEach((tool, index) => {
    if (deny.some((pattern) => toolMatches(pattern, tool))) {
      ctx.fail(`permissions.tools.approval_required[${index}]`, "conflict", `"${tool}" is also denied`);
    }
  });
  allow.forEach((tool, index) => {
    if (deny.includes(tool)) ctx.fail(`permissions.tools.allow[${index}]`, "conflict", `"${tool}" is also denied`);
  });
  const secrets = stringListAt(ctx, perms?.secrets, "permissions.secrets", { pattern: SECRET_REF_RE });
  return { tools: { allow, deny, approvalRequired }, secrets };
}

function normalizeRuntime(ctx, value) {
  const rt = objectAt(ctx, value, "runtime", ["durable", "max_attempts", "timeout", "retry", "concurrency", "approval_timeout"], {
    required: false,
  }) || {};
  if (rt.durable !== undefined && typeof rt.durable !== "boolean") {
    ctx.fail("runtime.durable", "invalid_type", "expected a boolean");
  }
  const retry = objectAt(ctx, rt.retry, "runtime.retry", ["backoff", "initial_delay", "max_delay"], { required: false }) || {};
  const out = {
    durable: rt.durable !== false,
    maxAttempts: integerAt(ctx, rt.max_attempts, "runtime.max_attempts", 3, { min: 1, max: MAX_ATTEMPTS_LIMIT }),
    timeoutMs: durationAt(ctx, rt.timeout, "runtime.timeout", 30 * 60_000, { min: 1000 }),
    approvalTimeoutMs: durationAt(ctx, rt.approval_timeout, "runtime.approval_timeout", 24 * 3_600_000, { min: 60_000 }),
    concurrency: stringAt(ctx, rt.concurrency, "runtime.concurrency", { required: false, oneOf: AGENT_JOB_CONCURRENCY }) || "forbid",
    retry: {
      backoff: stringAt(ctx, retry.backoff, "runtime.retry.backoff", { required: false, oneOf: AGENT_JOB_BACKOFF }) || "exponential",
      initialDelayMs: durationAt(ctx, retry.initial_delay, "runtime.retry.initial_delay", 30_000),
      maxDelayMs: durationAt(ctx, retry.max_delay, "runtime.retry.max_delay", 10 * 60_000),
    },
  };
  if (out.retry.maxDelayMs < out.retry.initialDelayMs) {
    ctx.fail("runtime.retry.max_delay", "out_of_range", "must be >= initial_delay");
  }
  if (!out.durable && out.maxAttempts > 1) {
    ctx.fail("runtime.max_attempts", "conflict", "non-durable jobs cannot retry; set max_attempts: 1");
  }
  return out;
}

function normalizeNotifications(ctx, value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    ctx.fail("notifications", "invalid_type", "expected a list");
    return [];
  }
  return value
    .map((raw, index) => {
      const path = `notifications[${index}]`;
      const entry = objectAt(ctx, raw, path, ["on", "channel", "target"]);
      if (!entry) return null;
      const on = stringListAt(ctx, entry.on, `${path}.on`, { oneOf: AGENT_JOB_NOTIFY_EVENTS });
      if (!on.length) ctx.fail(`${path}.on`, "required", "list at least one event");
      const channel = stringAt(ctx, entry.channel, `${path}.channel`, { oneOf: AGENT_JOB_NOTIFY_CHANNELS });
      const target = stringAt(ctx, entry.target, `${path}.target`, { max: 256 });
      if (channel === "webhook" && target && !/^https:\/\/\S+$|^vault:\/\//.test(target)) {
        ctx.fail(`${path}.target`, "invalid_format", "webhook targets must be https:// URLs or vault:// refs");
      }
      return { on, channel, target };
    })
    .filter(Boolean);
}

export function validateAgentJobSpec(input) {
  const ctx = createContext();
  if (!isPlainObject(input)) {
    ctx.fail("$", "invalid_type", "expected a job object");
    return { ok: false, errors: ctx.errors, spec: null };
  }
  checkKeys(ctx, input, "$", ["apiVersion", "kind", "metadata", "triggers", "agent", "task", "permissions", "runtime", "notifications"]);
  stringAt(ctx, input.apiVersion, "apiVersion", { oneOf: [AGENT_JOB_API_VERSION] });
  stringAt(ctx, input.kind, "kind", { oneOf: [AGENT_JOB_KIND] });
  const spec = {
    apiVersion: AGENT_JOB_API_VERSION,
    kind: AGENT_JOB_KIND,
    metadata: normalizeMetadata(ctx, input.metadata),
    triggers: normalizeTriggers(ctx, input.triggers),
    agent: normalizeAgent(ctx, input.agent),
    task: normalizeTask(ctx, input.task),
    permissions: normalizePermissions(ctx, input.permissions),
    runtime: normalizeRuntime(ctx, input.runtime),
    notifications: normalizeNotifications(ctx, input.notifications),
  };
  if (ctx.errors.length) return { ok: false, errors: ctx.errors, spec: null };
  return { ok: true, errors: [], spec };
}

export function normalizeAgentJobSpec(input) {
  const result = validateAgentJobSpec(input);
  if (!result.ok) throw new AgentJobSpecError(result.errors);
  return result.spec;
}

// Effective decision for a tool call under a normalized spec: deny wins, then
// approval_required, then allow. Unlisted tools are denied (default-deny).
export function agentJobToolDecision(spec, tool) {
  const { allow, deny, approvalRequired } = spec.permissions.tools;
  if (deny.some((pattern) => toolMatches(pattern, tool))) return "deny";
  if (approvalRequired.some((pattern) => toolMatches(pattern, tool))) return "approval_required";
  if (allow.some((pattern) => toolMatches(pattern, tool))) return "allow";
  return "deny";
}
