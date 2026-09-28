import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import {
  claudeCodeCommand,
  claudeCodeExecutionEnv,
  classifyClaudeCodeFailure,
} from "./claude-code-client.js";
import { claudeCodeStatusAuthenticated } from "./claude-code-auth-status.js";

// Read-only, sanitized subscription diagnostics via the existing managed CLI client.
// Never mutates profile/thread state, never calls verify/login endpoints, never
// appends events, never returns email/org/session/token/raw stderr/private paths.

const execFileAsync = promisify(execFile);

// Per-profile in-flight coalescing: only one full diagnostics run per profile at a time.
const pendingDiagnostics = new Map();
// Per-profile cooldown: cache result for 5 s to prevent rapid CLI spawning.
const diagnosticsCache = new Map();
const DIAGNOSTICS_CACHE_TTL_MS = 5_000;
const PROBE_TIMEOUT_MS = 10_000;

// Allowlisted pattern for provider-reported string values.
// Accepts alphanumerics, dots, underscores, hyphens only; max 40 chars.
// Rejects emails, paths, separators that could carry sensitive data.
const SAFE_VALUE_RE = /^[a-zA-Z0-9._-]{1,40}$/;

function clean(value = "") {
  return String(value || "").trim();
}

function safePick(value) {
  const s = clean(value);
  return SAFE_VALUE_RE.test(s) ? s : null;
}

/**
 * Extract allowlisted fields from parsed claude auth status JSON.
 * Only string fields matching SAFE_VALUE_RE are exposed.
 * Never returns email, orgId, userId, sessionId, token, apiKey, credentialRoot.
 */
function extractAllowlistedFields(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return {
    authMethod: safePick(parsed.authMethod),
    apiProvider: safePick(parsed.apiProvider),
    subscriptionType: safePick(parsed.subscriptionType),
  };
}

async function runAuthStatusProbe(profile, env) {
  // Same `claude auth status --json` probe and execution environment (including
  // a configured long-lived subscription token) as claudeCodeLoginStatus, so
  // diagnostics agree with login verification. Orkestr writes no profile state
  // and appends no events here; only allowlisted fields leave this module.
  const command = claudeCodeCommand(env);
  const runtimeEnv = await claudeCodeExecutionEnv(profile, {}, env);
  await Promise.all([
    fs.mkdir(runtimeEnv.HOME, { recursive: true, mode: 0o700 }),
    fs.mkdir(runtimeEnv.TMPDIR, { recursive: true, mode: 0o700 }),
  ]);
  try {
    const { stdout = "" } = await execFileAsync(command, ["auth", "status", "--json"], {
      env: runtimeEnv,
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: 256 * 1024,
    });
    const authenticated = claudeCodeStatusAuthenticated(stdout);
    let parsed = null;
    try { parsed = JSON.parse(stdout); } catch {}
    const extra = extractAllowlistedFields(parsed);
    return {
      available: true,
      authenticated,
      failureCode: authenticated ? null : "not_logged_in",
      ...extra,
    };
  } catch (error) {
    const available = error?.code !== "ENOENT";
    // Classify from sanitized fragments only; never include raw stderr in output.
    const classifyInput = [clean(error?.code), clean(error?.message).slice(0, 120)].join(" ");
    const failureCode = classifyClaudeCodeFailure(classifyInput);
    return { available, authenticated: false, failureCode, authMethod: null, apiProvider: null, subscriptionType: null };
  }
}

/**
 * Build a sanitized, allowlisted diagnostics response for the API.
 * Distinguishes: authenticated login, provider-reported subscription tier,
 * observed quota (not reported by auth status), and unknown multiplier.
 * multiplierReported is always null: no CLI or provider output reports a multiplier.
 * Subscription tier is never inferred from the profile label or any "Max" string.
 */
export function publicClaudeSubscriptionDiagnostics(profile = {}, probeResult = null) {
  const probe = probeResult || {};
  // Apply SAFE_VALUE_RE allowlist to all provider-reported strings regardless of call path.
  // extractAllowlistedFields does the same for raw CLI output; this is the public API contract.
  const safeAuthMethod = safePick(probe.authMethod);
  const safeApiProvider = safePick(probe.apiProvider);
  const safeSubscriptionType = safePick(probe.subscriptionType);
  return {
    profileId: clean(profile.id),
    profileState: clean(profile.state),
    // authenticated comes from the strict claudeCodeStatusAuthenticated parser output
    authenticated: probe.authenticated === true,
    available: probe.available !== false,
    authMethod: safeAuthMethod,
    apiProvider: safeApiProvider,
    // providerReportedSubscription: tier from CLI only; never inferred from label
    providerReportedSubscription: safeSubscriptionType ? { tier: safeSubscriptionType } : null,
    // observedQuota: auth status does not report quota
    observedQuota: null,
    // multiplierReported: no data source exposes a subscription multiplier value
    multiplierReported: null,
    failureCode: probe.failureCode || clean(profile.failureCode) || null,
    lastVerifiedAt: clean(profile.lastVerifiedAt) || null,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Run a bounded, coalesced read-only auth status probe and return sanitized diagnostics.
 * Coalescing and the 5-second cooldown cache operate at the full response level so
 * concurrent callers for the same profile receive the same result object and generatedAt.
 * Does not modify profile state, does not append events, does not call verify/login.
 */
export async function claudeCodeAccountDiagnostics(profile = {}, env = process.env) {
  const profileId = clean(profile.id);
  const cached = diagnosticsCache.get(profileId);
  if (cached && Date.now() - cached.cachedAt < DIAGNOSTICS_CACHE_TTL_MS) return cached.result;
  if (pendingDiagnostics.has(profileId)) return pendingDiagnostics.get(profileId);
  const run = (async () => {
    const probeResult = await runAuthStatusProbe(profile, env);
    return publicClaudeSubscriptionDiagnostics(profile, probeResult);
  })().finally(() => pendingDiagnostics.delete(profileId));
  pendingDiagnostics.set(profileId, run);
  const result = await run;
  diagnosticsCache.set(profileId, { result, cachedAt: Date.now() });
  return result;
}

export function resetClaudeCodeDiagnosticsForTest() {
  pendingDiagnostics.clear();
  diagnosticsCache.clear();
}
