import fs from "node:fs/promises";
import path from "node:path";
import { userDataPaths } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeJson } from "../../storage/src/store.js";
import { deleteTimer, listTimers } from "./timers.js";
import { clearUserPrivateIdentities, disableUser, enableUser, getUser, normalizeUserId, publicUser } from "./users.js";

const onboardingStates = new Set(["invited", "consented", "provisioned", "active", "paused", "offboarded"]);
const supportTypes = new Set(["help", "pause", "export", "delete", "connector", "desktop"]);
const userConnectorTokenFiles = [
  ["gmail", "gmail-token.json"],
  ["outlook", "outlook-token.json"],
  ["jira", "jira-token.json"],
  ["shopify", "shopify-token.json"],
];

function nowIso() {
  return new Date().toISOString();
}

function clean(value = "") {
  return String(value || "").trim();
}

function boolValue(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return value === true || value === "true" || value === 1 || value === "1";
}

function onboardingError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function publicBaseUrl(env = process.env) {
  return clean(env.ORKESTR_PUBLIC_SITE_URL || env.ORKESTR_PRIMARY_PUBLIC_URL || env.ORKESTR_PRIMARY_DOMAIN && `https://${env.ORKESTR_PRIMARY_DOMAIN}` || env.ORKESTR_PUBLIC_HTTPS_URL || env.ORKESTR_PUBLIC_URL || "https://orkestr.example");
}

function appBaseUrl(env = process.env) {
  return clean(env.ORKESTR_PUBLIC_APP_URL || env.ORKESTR_PUBLIC_HTTPS_URL || env.ORKESTR_PUBLIC_URL || `${publicBaseUrl(env)}/app`);
}

function normalizeChannel(value = "whatsapp") {
  const channel = clean(value).toLowerCase();
  return channel === "email" ? "email" : "whatsapp";
}

function normalizeSupportType(value = "help") {
  const type = clean(value).toLowerCase();
  return supportTypes.has(type) ? type : "help";
}

function normalizeOnboardingState(value = "invited") {
  const state = clean(value).toLowerCase();
  return onboardingStates.has(state) ? state : "invited";
}

function userOnboardingDefaults(userId = "") {
  return {
    schemaVersion: 1,
    userId: normalizeUserId(userId),
    state: "invited",
    invite: null,
    profile: publicOnboardingProfile(),
    supportRequests: [],
    updatedAt: nowIso(),
  };
}

function safeProfileText(value = "", max = 2000) {
  return clean(value).slice(0, max);
}

function publicOnboardingProfile(profile = {}) {
  return {
    displayName: safeProfileText(profile.displayName || profile.name, 120),
    timezone: safeProfileText(profile.timezone, 80),
    locale: safeProfileText(profile.locale || profile.language, 80),
    preferences: safeProfileText(profile.preferences, 4000),
    toolRequests: safeProfileText(profile.toolRequests || profile.tools, 4000),
    notes: safeProfileText(profile.notes || profile.context, 4000),
    updatedAt: clean(profile.updatedAt),
  };
}

function optionalProfileValue(input = {}, keys = [], max = 2000) {
  const present = keys.find((key) => input[key] !== undefined);
  if (!present) return undefined;
  const value = safeProfileText(input[present], max);
  return value || undefined;
}

function profilePatch(input = {}) {
  return {
    displayName: optionalProfileValue(input, ["displayName", "name"], 120),
    timezone: optionalProfileValue(input, ["timezone"], 80),
    locale: optionalProfileValue(input, ["locale", "language"], 80),
    preferences: optionalProfileValue(input, ["preferences"], 4000),
    toolRequests: optionalProfileValue(input, ["toolRequests", "tools"], 4000),
    notes: optionalProfileValue(input, ["notes", "context"], 4000),
  };
}

function mergeProfile(existing = {}, patch = {}) {
  const next = { ...publicOnboardingProfile(existing) };
  for (const [key, value] of Object.entries(profilePatch(patch))) {
    if (value !== undefined) next[key] = value;
  }
  next.updatedAt = nowIso();
  return publicOnboardingProfile(next);
}

export function buildExternalUserInviteTemplate(input = {}, env = process.env) {
  const channel = normalizeChannel(input.channel || "whatsapp");
  const name = clean(input.name || input.displayName || "there");
  const inviter = clean(input.inviter || "I");
  const productUrl = publicBaseUrl(env);
  const applicationUrl = appBaseUrl(env);
  const consentPhrase = clean(input.consentPhrase || "I agree to use Orkestr beta with my own accounts");
  const intro = channel === "email"
    ? `Hi ${name},\n\n${inviter} invited you to try Orkestr.`
    : `Hi ${name}, ${inviter} invited you to try Orkestr.`;
  const message = [
    intro,
    "Orkestr is an invite-only beta assistant you can use from WhatsApp. It can help with your own files, timers, managed browser work, and accounts you choose to connect.",
    `Before I create your private Orkestr chat, please read: ${productUrl}/terms and ${productUrl}/privacy`,
    `If you agree, reply exactly: ${consentPhrase}`,
    `After that I will create your private chat and send the first message there. App entry for invited users: ${applicationUrl}`,
  ].join(channel === "email" ? "\n\n" : "\n");
  return {
    ok: true,
    channel,
    consentPhrase,
    publicSiteUrl: productUrl,
    appUrl: applicationUrl,
    message,
  };
}

export function buildProvisioningChecklist(input = {}, env = process.env) {
  const userId = normalizeUserId(input.userId || input.id || input.email || input.phoneNumber || "new-user");
  const connectionName = clean(input.connectionName || input.chatName || `${userId}-orkestr`);
  const phoneNumber = clean(input.phoneNumber || input.phone);
  const email = clean(input.email);
  return {
    ok: true,
    userId,
    connectionName,
    inputs: {
      displayName: clean(input.displayName || input.name),
      email,
      phoneNumber,
      publicSiteUrl: publicBaseUrl(env),
      appUrl: appBaseUrl(env),
    },
    steps: [
      { id: "consent", label: "Confirm consent", required: true, done: boolValue(input.consented) },
      { id: "user", label: "Create or update user with role=user and maxThreads=1", required: true, done: false },
      { id: "wa-group", label: `Create WhatsApp group named ${connectionName}`, required: true, done: false },
      { id: "wa-identity", label: "Bind the sender phone/chat to this user", required: true, done: Boolean(phoneNumber) },
      { id: "thread", label: "Create first isolated thread owned by this user", required: true, done: false },
      { id: "desktop", label: "Prepare user-scoped managed desktop", required: false, done: false },
      { id: "connectors", label: "Use parent-managed OAuth apps for any requested connectors", required: false, done: false },
      { id: "smoke", label: "Send a real WhatsApp hi and verify a useful reply", required: true, done: false },
    ],
  };
}

export async function readUserOnboardingState(userId, env = process.env) {
  const user = await getUser(userId, env);
  if (!user) throw onboardingError("user_not_found", 404);
  const file = userDataPaths(user.id, env).onboarding;
  const fallback = userOnboardingDefaults(user.id);
  const payload = await readJson(file, fallback);
  return {
    ...fallback,
    ...payload,
    userId: user.id,
    state: normalizeOnboardingState(payload.state || fallback.state),
    profile: publicOnboardingProfile(payload.profile || fallback.profile),
    supportRequests: Array.isArray(payload.supportRequests) ? payload.supportRequests.slice(-50) : [],
  };
}

export async function setUserOnboardingState(userId, patch = {}, env = process.env) {
  const user = await getUser(userId, env);
  if (!user) throw onboardingError("user_not_found", 404);
  const existing = await readUserOnboardingState(user.id, env);
  const next = {
    ...existing,
    state: normalizeOnboardingState(patch.state || existing.state),
    invite: patch.invite === undefined ? existing.invite : patch.invite,
    profile: patch.profile === undefined ? existing.profile : mergeProfile(existing.profile, patch.profile),
    updatedAt: nowIso(),
  };
  await writeJson(userDataPaths(user.id, env).onboarding, next);
  await appendEvent({
    type: "user_onboarding_state_updated",
    userId: user.id,
    state: next.state,
  }, env).catch(() => {});
  return { ok: true, user: publicUser(user, env), onboarding: next };
}

export async function readUserOnboardingProfileForPrincipal(principal = {}, env = process.env) {
  const userId = normalizeUserId(principal?.userId);
  if (!userId) throw onboardingError("user_required", 403);
  const onboarding = await readUserOnboardingState(userId, env);
  return { ok: true, userId, profile: onboarding.profile };
}

export async function updateUserOnboardingProfileForPrincipal(input = {}, principal = {}, env = process.env) {
  const userId = normalizeUserId(principal?.userId);
  if (!userId) throw onboardingError("user_required", 403);
  const updated = await setUserOnboardingState(userId, { profile: input }, env);
  await appendEvent({
    type: "user_onboarding_profile_updated",
    userId,
  }, env).catch(() => {});
  return { ok: true, userId, profile: updated.onboarding.profile };
}

export async function recordUserSupportRequest(userId, input = {}, env = process.env) {
  const user = await getUser(userId, env);
  if (!user) throw onboardingError("user_not_found", 404);
  const existing = await readUserOnboardingState(user.id, env);
  const type = normalizeSupportType(input.type || input.kind || "help");
  const request = {
    id: `support-${Date.now().toString(36)}`,
    type,
    message: clean(input.message || input.text || "").slice(0, 2000),
    status: "open",
    createdAt: nowIso(),
  };
  const next = {
    ...existing,
    supportRequests: [...existing.supportRequests, request].slice(-50),
    updatedAt: nowIso(),
  };
  await writeJson(userDataPaths(user.id, env).onboarding, next);
  await appendEvent({
    type: "user_support_requested",
    userId: user.id,
    supportType: type,
    requestId: request.id,
  }, env).catch(() => {});
  return {
    ok: true,
    userId: user.id,
    request,
    reply: supportReply(type),
  };
}

export async function offboardUser(userId, input = {}, env = process.env) {
  const actorUserId = clean(input.actorUserId || "admin") || "admin";
  const action = clean(input.action || "pause").toLowerCase() === "offboard" ? "offboard" : "pause";
  const revokeConnectors = boolValue(input.revokeConnectors, true);
  const stopTimers = boolValue(input.stopTimers, true);
  const user = action === "pause"
    ? await disableUser(userId, env)
    : await disableUser(userId, env);
  let revokedIdentities = { removedCount: 0, identities: [] };
  let removedTokenFiles = [];
  let deletedTimerIds = [];
  if (revokeConnectors) {
    revokedIdentities = await clearUserPrivateIdentities(user.id, { env, actorUserId });
    removedTokenFiles = await removeUserConnectorTokenFiles(user.id, env);
  }
  if (stopTimers) {
    deletedTimerIds = await deleteUserTimers(user.id, env);
  }
  const onboarding = await setUserOnboardingState(user.id, {
    state: action === "offboard" ? "offboarded" : "paused",
  }, env);
  await appendEvent({
    type: action === "offboard" ? "user_offboarded" : "user_paused",
    userId: user.id,
    actorUserId,
    revokedConnectorIdentityCount: revokedIdentities.removedCount || 0,
    removedTokenFileCount: removedTokenFiles.length,
    deletedTimerCount: deletedTimerIds.length,
  }, env).catch(() => {});
  return {
    ok: true,
    action,
    user: publicUser(user, env),
    onboarding: onboarding.onboarding,
    revokedConnectorIdentityCount: revokedIdentities.removedCount || 0,
    removedTokenFiles,
    deletedTimerIds,
    note: "Files and workspaces are preserved unless an operator deletes them separately after export/review.",
  };
}

export async function resumeOnboardedUser(userId, env = process.env) {
  const user = await enableUser(userId, env);
  const onboarding = await setUserOnboardingState(user.id, { state: "active" }, env);
  return { ok: true, user: publicUser(user, env), onboarding: onboarding.onboarding };
}

async function deleteUserTimers(userId, env = process.env) {
  const timers = await listTimers(env);
  const owned = timers.filter((timer) => normalizeUserId(timer.ownerUserId || timer.userId) === normalizeUserId(userId));
  const deleted = [];
  for (const timer of owned) {
    if (await deleteTimer(timer.id, env)) deleted.push(timer.id);
  }
  return deleted;
}

async function removeUserConnectorTokenFiles(userId, env = process.env) {
  const secretsDir = userDataPaths(userId, env).secrets;
  const removed = [];
  for (const [providerId, tokenFile] of userConnectorTokenFiles) {
    const target = path.join(secretsDir, tokenFile);
    try {
      await fs.rm(target, { force: true });
      removed.push(providerId);
    } catch {
      // Missing or locked token files are reported through the remaining checklist.
    }
  }
  return removed;
}

function supportReply(type) {
  if (type === "pause") return "I recorded the pause request. The operator should disable new work and review active connectors/timers.";
  if (type === "export") return "I recorded the export request. The operator should prepare user-visible files and task records where practical.";
  if (type === "delete") return "I recorded the deletion request. The operator should pause the user first, export if needed, revoke connectors, then remove beta data after review.";
  if (type === "connector") return "I recorded the connector support request. The operator should check the scoped connector grant and parent app status.";
  if (type === "desktop") return "I recorded the desktop support request. The operator should check the user-scoped managed desktop lease and login state.";
  return "I recorded the support request. The operator should review it from the Orkestr admin surface.";
}
