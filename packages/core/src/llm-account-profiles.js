import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { userDataPaths } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeSecretJson } from "../../storage/src/store.js";
import { withStorageFileLock } from "../../storage/src/storage-lock.js";
import { normalizeUserId } from "./users.js";

const providers = new Set(["codex", "claude-code"]);
const authModes = new Set(["subscription"]);
const profileStates = new Set(["login_required", "ready", "rate_limited", "revoked", "error"]);

function clean(value = "") {
  return String(value || "").trim();
}

function nowIso() {
  return new Date().toISOString();
}

function normalizedOwner(value = "") {
  const raw = clean(value);
  return raw ? normalizeUserId(raw) : "";
}

function profileError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = message;
  return error;
}

function profileStorePath(ownerUserId, env = process.env) {
  return path.join(userDataPaths(normalizedOwner(ownerUserId), env).secrets, "llm-account-profiles.json");
}

function credentialRoot(ownerUserId, provider, profileId, env = process.env) {
  return path.join(userDataPaths(normalizedOwner(ownerUserId), env).root, "runtimes", provider, profileId);
}

function normalizeProvider(value = "") {
  const provider = clean(value).toLowerCase();
  if (!providers.has(provider)) throw profileError("llm_account_provider_unsupported");
  return provider;
}

function normalizeAuthMode(value = "subscription") {
  const authMode = clean(value || "subscription").toLowerCase();
  if (!authModes.has(authMode)) throw profileError("llm_account_auth_mode_unsupported");
  return authMode;
}

function normalizeLabel(value = "") {
  const label = clean(value).replace(/[\r\n\0]/g, " ").slice(0, 120);
  if (!label) throw profileError("llm_account_label_required");
  return label;
}

async function readProfiles(ownerUserId, env = process.env) {
  const state = await readJson(profileStorePath(ownerUserId, env), { profiles: [] });
  return Array.isArray(state?.profiles) ? state.profiles : [];
}

async function mutateProfiles(ownerUserId, env, operation) {
  const file = profileStorePath(ownerUserId, env);
  return withStorageFileLock(file, async () => {
    const profiles = await readProfiles(ownerUserId, env);
    const result = await operation(profiles);
    await writeSecretJson(file, { version: 1, profiles, updatedAt: nowIso() });
    return result;
  }, { timeoutMs: 15_000, staleMs: 60_000, heartbeatMs: 5_000 });
}

export function publicLlmAccountProfile(profile = {}) {
  return {
    id: clean(profile.id),
    provider: clean(profile.provider),
    label: clean(profile.label),
    authMode: clean(profile.authMode),
    state: clean(profile.state),
    createdAt: clean(profile.createdAt),
    updatedAt: clean(profile.updatedAt),
    lastVerifiedAt: clean(profile.lastVerifiedAt) || null,
    revokedAt: clean(profile.revokedAt) || null,
    failureCode: clean(profile.failureCode) || null,
    authenticationMethod: profile.subscriptionToken || profile.authenticationMethod === "subscription_token" ? "subscription_token" : "browser_login",
    tokenConfiguredAt: clean(profile.tokenConfiguredAt) || null,
    credentialRevision: Number(profile.credentialRevision || 0),
  };
}

export async function listLlmAccountProfiles(ownerUserId, options = {}, env = process.env) {
  const owner = normalizedOwner(ownerUserId);
  if (!owner) throw profileError("llm_account_owner_required", 403);
  const provider = clean(options.provider).toLowerCase();
  return (await readProfiles(owner, env))
    .filter((profile) => !provider || profile.provider === provider)
    .filter((profile) => options.includeRevoked === true || profile.state !== "revoked")
    .map(publicLlmAccountProfile);
}

export async function createLlmAccountProfile(ownerUserId, input = {}, env = process.env) {
  const owner = normalizedOwner(ownerUserId);
  if (!owner) throw profileError("llm_account_owner_required", 403);
  const provider = normalizeProvider(input.provider);
  const authMode = normalizeAuthMode(input.authMode);
  const label = normalizeLabel(input.label);
  const createdAt = nowIso();
  const profile = {
    id: `llm_${crypto.randomBytes(18).toString("base64url")}`,
    ownerUserId: owner,
    provider,
    label,
    authMode,
    state: "login_required",
    createdAt,
    updatedAt: createdAt,
    lastVerifiedAt: "",
    revokedAt: "",
    failureCode: "",
  };
  await mutateProfiles(owner, env, async (profiles) => {
    if (profiles.some((entry) => entry.provider === provider && entry.state !== "revoked" && entry.label.toLowerCase() === label.toLowerCase())) {
      throw profileError("llm_account_label_conflict", 409);
    }
    profiles.push(profile);
  });
  await fs.mkdir(credentialRoot(owner, provider, profile.id, env), { recursive: true, mode: 0o700 });
  await appendEvent({ type: "llm_account_profile_created", ownerUserId: owner, profileId: profile.id, provider, authMode }, env);
  return publicLlmAccountProfile(profile);
}

export async function updateLlmAccountProfileState(ownerUserId, profileId, state, options = {}, env = process.env) {
  const owner = normalizedOwner(ownerUserId);
  if (!owner) throw profileError("llm_account_owner_required", 403);
  const id = clean(profileId);
  const normalizedState = clean(state).toLowerCase();
  if (!profileStates.has(normalizedState)) throw profileError("llm_account_state_invalid");
  return mutateProfiles(owner, env, async (profiles) => {
    const profile = profiles.find((entry) => entry.id === id && entry.ownerUserId === owner);
    if (!profile) throw profileError("llm_account_profile_not_found", 404);
    // Verification/recovery may have started before revocation. Check under the
    // store lock so no delayed login or runtime failure can resurrect this ID.
    if (profile.state === "revoked") {
      if (normalizedState !== "revoked") throw profileError("llm_account_profile_revoked", 410);
      return publicLlmAccountProfile(profile);
    }
    if (options.credentialRevision !== undefined && Number(options.credentialRevision) !== Number(profile.credentialRevision || 0)) {
      throw profileError("llm_account_credentials_changed", 409);
    }
    profile.state = normalizedState;
    profile.updatedAt = nowIso();
    profile.lastVerifiedAt = options.verified === true ? profile.updatedAt : profile.lastVerifiedAt || "";
    profile.revokedAt = normalizedState === "revoked" ? profile.updatedAt : "";
    if (normalizedState === "revoked") delete profile.subscriptionToken;
    profile.failureCode = clean(options.failureCode).slice(0, 120);
    return publicLlmAccountProfile(profile);
  });
}

/**
 * @param {{ ownerUserId?: string, profileId?: string, provider?: string, requireReady?: boolean, allowRevoked?: boolean }} input
 * @param {NodeJS.ProcessEnv} env
 */
export async function resolveLlmAccountProfile({ ownerUserId, profileId, provider, requireReady = true, allowRevoked = false } = {}, env = process.env) {
  const owner = normalizedOwner(ownerUserId);
  const id = clean(profileId);
  const normalizedProvider = normalizeProvider(provider);
  if (!owner || !id) throw profileError("llm_account_profile_required", 428);
  const profile = (await readProfiles(owner, env)).find((entry) => entry.id === id);
  if (!profile || profile.ownerUserId !== owner) throw profileError("llm_account_profile_not_found", 404);
  if (profile.provider !== normalizedProvider) throw profileError("llm_account_provider_mismatch", 409);
  if (profile.state === "revoked" && !allowRevoked) throw profileError("llm_account_profile_revoked", 410);
  if (requireReady && profile.state !== "ready") throw profileError("llm_account_profile_not_ready", 428);
  const root = credentialRoot(owner, normalizedProvider, id, env);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  // Secret material must not escape through general profile resolution.
  const { subscriptionToken, ...safeProfile } = profile;
  return { ...safeProfile, authenticationMethod: subscriptionToken ? "subscription_token" : "browser_login", credentialRoot: root };
}

// Tokens enter only through the owner-scoped authenticated account API. Never
// accept a credential path or inherit a host-global token for a tenant profile.
export async function setClaudeSubscriptionToken(ownerUserId, profileId, token, env = process.env) {
  const value = typeof token === "string" ? token.trim() : "";
  if (!/^sk-ant-oat01-[A-Za-z0-9_-]{20,4096}$/.test(value)) throw profileError("claude_subscription_token_invalid");
  const owner = normalizedOwner(ownerUserId);
  if (!owner) throw profileError("llm_account_owner_required", 403);
  return mutateProfiles(owner, env, async (profiles) => {
    const profile = profiles.find(entry => entry.id === clean(profileId) && entry.ownerUserId === owner);
    if (!profile) throw profileError("llm_account_profile_not_found", 404);
    if (profile.state === "revoked") throw profileError("llm_account_profile_revoked", 410);
    if (profile.provider !== "claude-code" || profile.authMode !== "subscription") throw profileError("llm_account_auth_mode_unsupported", 409);
    profile.subscriptionToken = value;
    profile.tokenConfiguredAt = nowIso();
    profile.credentialRevision = Number(profile.credentialRevision || 0) + 1;
    profile.updatedAt = profile.tokenConfiguredAt;
    profile.state = "login_required";
    profile.failureCode = "claude_code_verification_required";
    profile.lastVerifiedAt = "";
    return publicLlmAccountProfile(profile);
  });
}

export async function claudeSubscriptionTokenForRuntime(profile, env = process.env) {
  if (!profile?.id || !profile?.ownerUserId) return "";
  const current = (await readProfiles(profile.ownerUserId, env)).find(entry => entry.id === profile.id && entry.ownerUserId === profile.ownerUserId);
  if (!current) throw profileError("llm_account_profile_not_found", 404);
  if (current.state === "revoked") throw profileError("llm_account_profile_revoked", 410);
  if (current.provider !== "claude-code") throw profileError("llm_account_provider_mismatch", 409);
  if (Number(current.credentialRevision || 0) !== Number(profile.credentialRevision || 0)) throw profileError("llm_account_credentials_changed", 409);
  return current.subscriptionToken || "";
}

export async function revokeLlmAccountProfile(ownerUserId, profileId, env = process.env) {
  const updated = await updateLlmAccountProfileState(ownerUserId, profileId, "revoked", {}, env);
  await appendEvent({ type: "llm_account_profile_revoked", ownerUserId: normalizedOwner(ownerUserId), profileId: updated.id, provider: updated.provider }, env);
  return updated;
}
