import { createHash } from "node:crypto";
import fs from "node:fs/promises";

export const LINKEDIN_OUTREACH_SCOPE_CONTRACT_VERSION = "linkedin.outreach-scope.v1";
export const LINKEDIN_OUTREACH_SCOPE_STAGES = Object.freeze([
  "selector",
  "claim",
  "intake",
  "outcome_writer",
  "detached_worker",
  "recovery",
  "requeue",
]);

const safeValuePattern = /^[a-zA-Z0-9][a-zA-Z0-9_.:@/-]{0,159}$/;

function clean(value = "") {
  return String(value || "").trim();
}

function scopeError(code, statusCode = 409, safeScope = null) {
  const error = new Error(code);
  error.code = code;
  error.statusCode = statusCode;
  if (safeScope) error.outreachScope = safeScope;
  return error;
}

function safeValue(value = "", field = "linkedin_outreach_scope_value") {
  const normalized = clean(value);
  if (!normalized || !safeValuePattern.test(normalized)) {
    throw scopeError(`${field}_invalid`, 400);
  }
  return normalized;
}

function safePublicIdentity(value = "") {
  const normalized = clean(value);
  return safeValuePattern.test(normalized) ? normalized : "";
}

function normalizeEndpoint(value = "") {
  const raw = clean(value);
  if (!raw) throw scopeError("linkedin_outreach_oxrm_endpoint_missing", 409);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw scopeError("linkedin_outreach_oxrm_endpoint_invalid", 400);
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw scopeError("linkedin_outreach_oxrm_endpoint_invalid", 400);
  }
  const pathname = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "");
  return `${parsed.protocol}//${parsed.host}${pathname}`;
}

function fingerprintFor(binding = {}) {
  const canonical = [
    binding.bindingId,
    binding.threadId,
    binding.desktopSlug,
    binding.outreachWorkspaceId,
    binding.linkedinAccountAlias,
    binding.oxrmEndpointId,
    binding.oxrmEndpoint,
  ].join("\n");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

function normalizeBinding(raw = {}) {
  const binding = {
    contractVersion: LINKEDIN_OUTREACH_SCOPE_CONTRACT_VERSION,
    bindingId: safeValue(raw.bindingId || raw.id, "linkedin_outreach_binding_id"),
    threadId: safeValue(raw.threadId || raw.sessionId, "linkedin_outreach_thread_id"),
    desktopSlug: safeValue(raw.desktopSlug || raw.linkedinDesktopSlug, "linkedin_outreach_desktop_slug"),
    outreachWorkspaceId: safeValue(raw.outreachWorkspaceId, "linkedin_outreach_workspace_id"),
    linkedinAccountAlias: safeValue(raw.linkedinAccountAlias, "linkedin_account_alias"),
    oxrmEndpointId: safeValue(raw.oxrmEndpointId || raw.endpointId, "linkedin_outreach_oxrm_endpoint_id"),
    oxrmEndpoint: normalizeEndpoint(raw.oxrmEndpoint || raw.oxrmMcpEndpoint || raw.endpoint),
  };
  binding.bindingFingerprint = fingerprintFor(binding);
  return Object.freeze(binding);
}

function collisionKey(binding = {}, fields = []) {
  return fields.map((field) => binding[field]).join("\n");
}

function assertConsistentBindings(bindings = []) {
  const exactKeys = [
    ["bindingId"],
    ["threadId"],
  ];
  for (const fields of exactKeys) {
    const seen = new Set();
    for (const binding of bindings) {
      const key = collisionKey(binding, fields);
      if (seen.has(key)) throw scopeError("linkedin_outreach_binding_ambiguous", 409);
      seen.add(key);
    }
  }

  const consistencyGroups = [
    ["desktopSlug"],
    ["linkedinAccountAlias"],
    ["outreachWorkspaceId", "linkedinAccountAlias"],
    ["oxrmEndpointId"],
    ["oxrmEndpoint"],
  ];
  for (const fields of consistencyGroups) {
    const seen = new Map();
    for (const binding of bindings) {
      const key = collisionKey(binding, fields);
      const scope = [binding.desktopSlug, binding.outreachWorkspaceId, binding.linkedinAccountAlias, binding.oxrmEndpointId, binding.oxrmEndpoint].join("\n");
      const previous = seen.get(key);
      if (previous && previous !== scope) throw scopeError("linkedin_outreach_binding_inconsistent", 409);
      seen.set(key, scope);
    }
  }
  return bindings;
}

function parseBindingsJson(raw = "") {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw scopeError("linkedin_outreach_bindings_invalid", 400);
  }
  if (!Array.isArray(parsed)) throw scopeError("linkedin_outreach_bindings_invalid", 400);
  return parsed;
}

export async function loadLinkedInOutreachBindings(options = {}, env = process.env) {
  let source = options.outreachBindings || options.linkedinOutreachBindings;
  if (!source) {
    const inline = clean(env.ORKESTR_LINKEDIN_OUTREACH_BINDINGS_JSON);
    const filePath = clean(options.outreachBindingsFile || env.ORKESTR_LINKEDIN_OUTREACH_BINDINGS_FILE);
    if (inline && filePath) throw scopeError("linkedin_outreach_bindings_ambiguous", 409);
    if (inline) source = parseBindingsJson(inline);
    else if (filePath) {
      let contents;
      try {
        contents = await fs.readFile(filePath, "utf8");
      } catch {
        throw scopeError("linkedin_outreach_bindings_unavailable", 409);
      }
      source = parseBindingsJson(contents);
    }
    else source = [];
  }
  if (!Array.isArray(source)) throw scopeError("linkedin_outreach_bindings_invalid", 400);
  return assertConsistentBindings(source.map(normalizeBinding));
}

export function publicLinkedInOutreachScope(scope = {}) {
  const safe = {
    contractVersion: LINKEDIN_OUTREACH_SCOPE_CONTRACT_VERSION,
    bindingId: safePublicIdentity(scope.bindingId),
    bindingFingerprint: safePublicIdentity(scope.bindingFingerprint),
    threadId: safePublicIdentity(scope.threadId),
    desktopSlug: safePublicIdentity(scope.desktopSlug),
    outreachWorkspaceId: safePublicIdentity(scope.outreachWorkspaceId),
    linkedinAccountAlias: safePublicIdentity(scope.linkedinAccountAlias),
    oxrmEndpointId: safePublicIdentity(scope.oxrmEndpointId),
  };
  return Object.freeze(safe);
}

function requestedScope(input = {}) {
  const nested = input.outreachScope && typeof input.outreachScope === "object" ? input.outreachScope : {};
  const fields = ["bindingId", "bindingFingerprint", "threadId", "desktopSlug", "outreachWorkspaceId", "linkedinAccountAlias", "oxrmEndpointId"];
  const result = {};
  for (const field of fields) {
    const direct = clean(input[field] || (field === "bindingId" ? input.outreachBindingId : ""));
    const scoped = clean(nested[field]);
    if (direct && scoped && direct !== scoped) throw scopeError("linkedin_outreach_scope_inconsistent", 409, publicLinkedInOutreachScope({ ...nested, ...result }));
    result[field] = scoped || direct;
  }
  return result;
}

function assertScopeMatch(requested = {}, binding = {}) {
  const required = ["bindingId", "outreachWorkspaceId", "linkedinAccountAlias"];
  if (required.some((field) => !clean(requested[field]))) {
    throw scopeError("linkedin_outreach_scope_missing", 409, publicLinkedInOutreachScope(requested));
  }
  for (const field of ["bindingId", "threadId", "desktopSlug", "outreachWorkspaceId", "linkedinAccountAlias", "oxrmEndpointId"]) {
    if (clean(requested[field]) && clean(requested[field]) !== binding[field]) {
      throw scopeError("linkedin_outreach_scope_mismatch", 409, publicLinkedInOutreachScope(requested));
    }
  }
  if (clean(requested.bindingFingerprint) && requested.bindingFingerprint !== binding.bindingFingerprint) {
    throw scopeError("linkedin_outreach_scope_stale", 409, publicLinkedInOutreachScope(requested));
  }
}

export async function resolveLinkedInOutreachScope(input = {}, options = {}, env = process.env) {
  const requested = requestedScope(input);
  if (!requested.bindingId || !requested.outreachWorkspaceId || !requested.linkedinAccountAlias) {
    throw scopeError("linkedin_outreach_scope_missing", 409, publicLinkedInOutreachScope(requested));
  }
  const threadId = clean(options.threadId || input.threadId || requested.threadId);
  const desktopSlug = clean(options.desktopSlug || input.desktopSlug || requested.desktopSlug);
  if (!threadId || !desktopSlug) throw scopeError("linkedin_outreach_route_binding_missing", 409, publicLinkedInOutreachScope(requested));
  if (requested.threadId && requested.threadId !== threadId) throw scopeError("linkedin_outreach_scope_mismatch", 409, publicLinkedInOutreachScope(requested));
  if (requested.desktopSlug && requested.desktopSlug !== desktopSlug) throw scopeError("linkedin_outreach_scope_mismatch", 409, publicLinkedInOutreachScope(requested));

  const bindings = await loadLinkedInOutreachBindings(options, env);
  if (!bindings.length) throw scopeError("linkedin_outreach_bindings_missing", 409, publicLinkedInOutreachScope(requested));
  const matches = bindings.filter((binding) => binding.bindingId === requested.bindingId);
  if (matches.length !== 1) {
    throw scopeError(matches.length ? "linkedin_outreach_binding_ambiguous" : "linkedin_outreach_binding_missing", 409, publicLinkedInOutreachScope(requested));
  }
  const binding = matches[0];
  assertScopeMatch({ ...requested, threadId, desktopSlug }, binding);
  return binding;
}

function scopeFieldMismatch(payload = {}, expected = {}) {
  const provided = requestedScope(payload);
  for (const field of ["bindingId", "bindingFingerprint", "threadId", "desktopSlug", "outreachWorkspaceId", "linkedinAccountAlias", "oxrmEndpointId"]) {
    if (clean(provided[field]) && clean(provided[field]) !== clean(expected[field])) return true;
  }
  return false;
}

export function propagateLinkedInOutreachScope(payload = {}, scope = {}, stage = "intake") {
  const normalizedStage = clean(stage).toLowerCase();
  if (!LINKEDIN_OUTREACH_SCOPE_STAGES.includes(normalizedStage)) throw scopeError("linkedin_outreach_scope_stage_invalid", 400);
  const safe = publicLinkedInOutreachScope(scope);
  if (!safe.bindingId || !safe.bindingFingerprint || !safe.outreachWorkspaceId || !safe.linkedinAccountAlias || !safe.oxrmEndpointId) {
    throw scopeError("linkedin_outreach_scope_missing", 409, safe);
  }
  if (scopeFieldMismatch(payload, safe)) throw scopeError("linkedin_outreach_scope_mismatch", 409, safe);
  return {
    ...payload,
    bindingId: safe.bindingId,
    bindingFingerprint: safe.bindingFingerprint,
    outreachWorkspaceId: safe.outreachWorkspaceId,
    linkedinAccountAlias: safe.linkedinAccountAlias,
    oxrmEndpointId: safe.oxrmEndpointId,
    outreachScope: safe,
    outreachScopeStage: normalizedStage,
  };
}

export function assertLinkedInOutreachScope(payload = {}, scope = {}) {
  const provided = requestedScope(payload);
  if (!provided.bindingId || !provided.bindingFingerprint || !provided.outreachWorkspaceId || !provided.linkedinAccountAlias || !provided.oxrmEndpointId) {
    throw scopeError("linkedin_outreach_scope_missing", 409, publicLinkedInOutreachScope(provided));
  }
  if (scopeFieldMismatch(payload, publicLinkedInOutreachScope(scope))) {
    throw scopeError("linkedin_outreach_scope_mismatch", 409, publicLinkedInOutreachScope(provided));
  }
  return publicLinkedInOutreachScope(scope);
}

function callOutreachScopeStage(call = {}) {
  const explicit = clean(call.outreachScopeStage).toLowerCase();
  if (explicit) return explicit;
  const generic = clean(call.stage).toLowerCase();
  return LINKEDIN_OUTREACH_SCOPE_STAGES.includes(generic) ? generic : "intake";
}

export async function bindLinkedInOutreachPlan(plan = {}, options = {}, env = process.env) {
  if (!Array.isArray(plan?.calls)) throw scopeError("linkedin_mcp_plan_calls_required", 400);
  const persistedStages = new Set(["detached_worker", "recovery", "requeue"]);
  const requiresSnapshot = persistedStages.has(clean(plan.outreachScopeStage).toLowerCase())
    || plan.calls.some((call) => persistedStages.has(callOutreachScopeStage(call)));
  const snapshotFingerprint = clean(plan.outreachScope?.bindingFingerprint || plan.bindingFingerprint);
  if (requiresSnapshot && !snapshotFingerprint) {
    throw scopeError("linkedin_outreach_scope_snapshot_missing", 409, publicLinkedInOutreachScope(plan.outreachScope || plan));
  }
  const scope = await resolveLinkedInOutreachScope(plan, options, env);
  const safe = publicLinkedInOutreachScope(scope);
  const calls = plan.calls.map((call) => {
    const stage = callOutreachScopeStage(call);
    return {
      ...call,
      input: propagateLinkedInOutreachScope(call.input || {}, safe, stage),
      outreachScope: safe,
      outreachScopeStage: stage,
    };
  });
  return {
    scope,
    plan: {
      ...plan,
      threadId: scope.threadId,
      desktopSlug: scope.desktopSlug,
      bindingId: safe.bindingId,
      bindingFingerprint: safe.bindingFingerprint,
      outreachWorkspaceId: safe.outreachWorkspaceId,
      linkedinAccountAlias: safe.linkedinAccountAlias,
      oxrmEndpointId: safe.oxrmEndpointId,
      outreachScope: safe,
      calls,
    },
  };
}

export async function restoreLinkedInOutreachWork(work = {}, options = {}, env = process.env) {
  if (!clean(work.outreachScope?.bindingFingerprint || work.bindingFingerprint)) {
    throw scopeError("linkedin_outreach_scope_snapshot_missing", 409, publicLinkedInOutreachScope(work.outreachScope || work));
  }
  const scope = await resolveLinkedInOutreachScope(work, options, env);
  const stage = clean(options.stage || work.outreachScopeStage || "recovery").toLowerCase();
  return { scope, work: propagateLinkedInOutreachScope(work, scope, stage) };
}

export function sanitizeLinkedInOutreachOutput(value, scope = {}) {
  const endpoint = clean(scope.oxrmEndpoint);
  const replacement = `[redacted:${clean(scope.oxrmEndpointId) || "oxrm-endpoint"}]`;
  if (typeof value === "string") return endpoint ? value.split(endpoint).join(replacement) : value;
  if (Array.isArray(value)) return value.map((item) => sanitizeLinkedInOutreachOutput(item, scope));
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "outreachScope") output[key] = publicLinkedInOutreachScope(item);
    else if (["oxrmEndpoint", "oxrmApiEndpoint", "oxrmMcpEndpoint"].includes(key)) output.oxrmEndpointId = clean(scope.oxrmEndpointId);
    else output[key] = sanitizeLinkedInOutreachOutput(item, scope);
  }
  return output;
}
