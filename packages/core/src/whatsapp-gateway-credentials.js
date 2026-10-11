// Credential and scope rules for the invitation-only managed WhatsApp gateway
// (mode B in docs/spec/whatsapp-docker-onboarding.md, section 3.3).
//
// Pure functions over a plain state object, so the rules can be tested without
// files, network, or a WhatsApp account. Persistence and HTTP routes are a
// later increment. Secrets (invite codes, access tokens) are only ever stored
// as SHA-256 hashes; scope (relay account, allowed chat) is fixed by the
// operator's invitation and cannot be changed by the instance.
import crypto from "node:crypto";

export const GATEWAY_STATE_VERSION = 1;
export const DEFAULTS = Object.freeze({
  inviteTtlMs: 24 * 60 * 60 * 1000,
  accessTokenTtlMs: 60 * 60 * 1000,
  clockSkewMs: 120 * 1000,
  maxInviteTtlMs: 7 * 24 * 60 * 60 * 1000,
});

export class GatewayCredentialError extends Error {
  constructor(code, statusCode = 403) {
    super(code);
    this.code = code;
    this.statusCode = statusCode;
  }
}

const fail = (code, statusCode) => {
  throw new GatewayCredentialError(code, statusCode);
};

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function hashEquals(expectedHex, value) {
  const actual = Buffer.from(sha256(value), "hex");
  const expected = Buffer.from(String(expectedHex || ""), "hex");
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function defaultRandom(bytes) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function clean(value, max = 200) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function createGatewayState() {
  return { version: GATEWAY_STATE_VERSION, invites: [], instances: [], chatOwners: {}, nonces: {} };
}

function chatKey(relayAccountId, chatId) {
  return `${relayAccountId}\u0000${chatId}`;
}

function activeOwner(state, relayAccountId, chatId) {
  const instanceId = state.chatOwners[chatKey(relayAccountId, chatId)];
  const instance = instanceId ? state.instances.find((item) => item.instanceId === instanceId) : null;
  return instance && !instance.revokedAt ? instance : null;
}

// Operator issues a single-use invitation bound to one relay account and chat.
export function issueInvite(state, { relayAccountId, chatId, label = "", ttlMs = DEFAULTS.inviteTtlMs, instanceTtlMs = 0, dailySendQuota = 200 } = {}, { now = Date.now(), random = defaultRandom } = {}) {
  const account = clean(relayAccountId, 120);
  const chat = clean(chatId, 200);
  if (!account || !chat) fail("invite_scope_required", 400);
  if (!(ttlMs > 0) || ttlMs > DEFAULTS.maxInviteTtlMs) fail("invite_ttl_invalid", 400);
  if (activeOwner(state, account, chat)) fail("chat_already_owned", 409);
  const code = `owi_${random(24)}`;
  const invite = {
    inviteId: `inv_${random(9)}`,
    codeHash: sha256(code),
    relayAccountId: account,
    chatId: chat,
    label: clean(label, 120),
    dailySendQuota: Math.max(0, Math.floor(dailySendQuota)),
    instanceTtlMs: Math.max(0, Math.floor(instanceTtlMs)),
    createdAt: now,
    expiresAt: now + ttlMs,
    usedAt: null,
    usedByInstanceId: null,
  };
  state.invites.push(invite);
  return { code, invite: publicInvite(invite) };
}

function issueAccessToken(instance, { now, random }) {
  const token = `owg_${random(32)}`;
  instance.accessTokenHash = sha256(token);
  instance.accessTokenExpiresAt = now + DEFAULTS.accessTokenTtlMs;
  return { accessToken: token, accessTokenExpiresAt: instance.accessTokenExpiresAt };
}

// Instance redeems an invite. Any scope fields the instance sends are ignored:
// scope comes only from the invitation record.
export function enrollInstance(state, { code, instancePublicKey } = {}, { now = Date.now(), random = defaultRandom } = {}) {
  const publicKey = clean(instancePublicKey, 400);
  if (!publicKey) fail("instance_public_key_required", 400);
  const invite = state.invites.find((item) => hashEquals(item.codeHash, clean(code, 200)));
  if (!invite) fail("invite_invalid", 403);
  if (invite.usedAt) fail("invite_already_used", 403);
  if (invite.expiresAt <= now) fail("invite_expired", 403);
  if (activeOwner(state, invite.relayAccountId, invite.chatId)) fail("chat_already_owned", 409);
  const instance = {
    instanceId: `gwi_${random(12)}`,
    inviteId: invite.inviteId,
    instancePublicKey: publicKey,
    relayAccountId: invite.relayAccountId,
    allowedChatIds: [invite.chatId],
    dailySendQuota: invite.dailySendQuota,
    createdAt: now,
    expiresAt: invite.instanceTtlMs ? now + invite.instanceTtlMs : null,
    revokedAt: null,
    revokeReason: "",
    lastSeenAt: null,
    accessTokenHash: "",
    accessTokenExpiresAt: 0,
  };
  invite.usedAt = now;
  invite.usedByInstanceId = instance.instanceId;
  state.instances.push(instance);
  state.chatOwners[chatKey(instance.relayAccountId, invite.chatId)] = instance.instanceId;
  return { instance: publicInstance(instance), ...issueAccessToken(instance, { now, random }) };
}

function pruneNonces(state, now) {
  for (const [key, expiresAt] of Object.entries(state.nonces)) if (expiresAt <= now) delete state.nonces[key];
}

// Checks every gateway call: credential, revocation, expiry, clock skew, and
// nonce replay. Heartbeats go through this too, so they cannot revive a
// revoked or expired instance.
export function authenticateRequest(state, { instanceId, accessToken, nonce, ts } = {}, { now = Date.now() } = {}) {
  const instance = state.instances.find((item) => item.instanceId === clean(instanceId, 120));
  if (!instance) fail("instance_unknown", 401);
  if (instance.revokedAt) fail("instance_revoked", 403);
  if (instance.expiresAt && instance.expiresAt <= now) fail("instance_expired", 403);
  if (!hashEquals(instance.accessTokenHash, clean(accessToken, 200))) fail("access_token_invalid", 401);
  if (instance.accessTokenExpiresAt <= now) fail("access_token_expired", 401);
  const requestTs = Number(ts);
  if (!Number.isFinite(requestTs) || Math.abs(now - requestTs) > DEFAULTS.clockSkewMs) fail("request_timestamp_out_of_window", 401);
  const nonceValue = clean(nonce, 120);
  if (nonceValue.length < 16) fail("request_nonce_invalid", 400);
  pruneNonces(state, now);
  const nonceKey = `${instance.instanceId}\u0000${nonceValue}`;
  if (state.nonces[nonceKey]) fail("request_replayed", 409);
  state.nonces[nonceKey] = now + 2 * DEFAULTS.clockSkewMs;
  instance.lastSeenAt = now;
  return publicInstance(instance);
}

// Rotates the access token after an authenticated request; the old token stops working.
export function refreshAccessToken(state, instanceId, { now = Date.now(), random = defaultRandom } = {}) {
  const instance = state.instances.find((item) => item.instanceId === instanceId);
  if (!instance) fail("instance_unknown", 401);
  if (instance.revokedAt) fail("instance_revoked", 403);
  if (instance.expiresAt && instance.expiresAt <= now) fail("instance_expired", 403);
  return issueAccessToken(instance, { now, random });
}

// Operator revokes an instance. Effective on the next call; frees its chats.
export function revokeInstance(state, instanceId, { reason = "operator_revoked", now = Date.now() } = {}) {
  const instance = state.instances.find((item) => item.instanceId === instanceId);
  if (!instance) fail("instance_unknown", 404);
  if (!instance.revokedAt) {
    instance.revokedAt = now;
    instance.revokeReason = clean(reason, 200);
    instance.accessTokenHash = "";
    for (const chatId of instance.allowedChatIds) {
      const key = chatKey(instance.relayAccountId, chatId);
      if (state.chatOwners[key] === instance.instanceId) delete state.chatOwners[key];
    }
  }
  return publicInstance(instance);
}

// Outbound: an authenticated instance may only send to its own allowlisted chats.
export function authorizeSend(instance, chatId) {
  if (!instance || instance.revokedAt) fail("instance_revoked", 403);
  if (!instance.allowedChatIds.includes(clean(chatId, 200))) fail("chat_not_allowed", 403);
  return true;
}

// Inbound: a message on (relayAccountId, chatId) goes to exactly one active owner, or nowhere.
export function routeInbound(state, { relayAccountId, chatId } = {}) {
  const owner = activeOwner(state, clean(relayAccountId, 120), clean(chatId, 200));
  return owner ? owner.instanceId : null;
}

function publicInvite(invite) {
  const { codeHash, ...rest } = invite;
  return { ...rest };
}

export function publicInstance(instance) {
  const { accessTokenHash, ...rest } = instance;
  return { ...rest, allowedChatIds: [...instance.allowedChatIds] };
}
