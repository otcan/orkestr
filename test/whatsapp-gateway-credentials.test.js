import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULTS,
  authenticateRequest,
  authorizeSend,
  createGatewayState,
  enrollInstance,
  issueInvite,
  refreshAccessToken,
  revokeInstance,
  routeInbound,
} from "../packages/core/src/whatsapp-gateway-credentials.js";

// Plan T10-T14 (docs/whatsapp-docker-onboarding-plan.md). Synthetic ids only.
const T0 = 1_800_000_000_000;
const chatA = "chat-a@g.example.test";
const chatB = "chat-b@g.example.test";
let counter = 0;
const random = () => `r${String(++counter).padStart(20, "0")}`;
const nonce = () => `nonce-${String(++counter).padStart(16, "0")}`;

function enrolled(state, chatId = chatA, now = T0) {
  const { code } = issueInvite(state, { relayAccountId: "relay-1", chatId }, { now, random });
  return enrollInstance(state, { code, instancePublicKey: "pk-test" }, { now, random });
}

test("invites are single-use, expire, and are stored only as hashes (T10)", () => {
  const state = createGatewayState();
  const { code, invite } = issueInvite(state, { relayAccountId: "relay-1", chatId: chatA }, { now: T0, random });
  assert.match(code, /^owi_/);
  assert.equal(invite.codeHash, undefined, "public view hides the hash");
  assert.ok(!JSON.stringify(state).includes(code), "the raw code is never stored");
  const result = enrollInstance(state, { code, instancePublicKey: "pk" }, { now: T0 + 1, random });
  assert.match(result.accessToken, /^owg_/);
  assert.ok(!JSON.stringify(state).includes(result.accessToken), "the raw token is never stored");
  assert.throws(() => enrollInstance(state, { code, instancePublicKey: "pk" }, { now: T0 + 2, random }), /invite_already_used/);
  assert.throws(() => enrollInstance(state, { code: "owi_wrong", instancePublicKey: "pk" }, { now: T0, random }), /invite_invalid/);
  const late = issueInvite(state, { relayAccountId: "relay-1", chatId: chatB, ttlMs: 1000 }, { now: T0, random });
  assert.throws(() => enrollInstance(state, { code: late.code, instancePublicKey: "pk" }, { now: T0 + 1000, random }), /invite_expired/);
  assert.throws(() => issueInvite(state, { relayAccountId: "relay-1", chatId: chatB, ttlMs: DEFAULTS.maxInviteTtlMs + 1 }, { now: T0, random }), /invite_ttl_invalid/);
  assert.throws(() => issueInvite(state, { chatId: chatB }, { now: T0, random }), /invite_scope_required/);
});

test("every call checks credential, revocation, expiry; heartbeats cannot revive a revoked instance (T11)", () => {
  const state = createGatewayState();
  const { instance, accessToken } = enrolled(state);
  const call = (overrides = {}, now = T0 + 10) => authenticateRequest(state, { instanceId: instance.instanceId, accessToken, nonce: nonce(), ts: now, ...overrides }, { now });
  assert.equal(call().instanceId, instance.instanceId);
  assert.throws(() => call({ accessToken: "owg_wrong" }), /access_token_invalid/);
  const late = T0 + DEFAULTS.accessTokenTtlMs + 1;
  assert.throws(() => call({}, late), /access_token_expired/);
  const rotated = refreshAccessToken(state, instance.instanceId, { now: T0 + 20, random });
  assert.throws(() => call(), /access_token_invalid/, "the old token stops working after rotation");
  assert.equal(call({ accessToken: rotated.accessToken }).instanceId, instance.instanceId);
  revokeInstance(state, instance.instanceId, { now: T0 + 30 });
  assert.throws(() => call({ accessToken: rotated.accessToken }), /instance_revoked/);
  assert.throws(() => call({ accessToken: rotated.accessToken }), /instance_revoked/, "a second (heartbeat) call is still refused");
  assert.throws(() => refreshAccessToken(state, instance.instanceId, { now: T0 + 40, random }), /instance_revoked/);

  const expiring = createGatewayState();
  const { code } = issueInvite(expiring, { relayAccountId: "relay-1", chatId: chatA, instanceTtlMs: 5000 }, { now: T0, random });
  const short = enrollInstance(expiring, { code, instancePublicKey: "pk" }, { now: T0, random });
  assert.throws(() => authenticateRequest(expiring, { instanceId: short.instance.instanceId, accessToken: short.accessToken, nonce: nonce(), ts: T0 + 5000 }, { now: T0 + 5000 }), /instance_expired/);
});

test("replayed nonces and out-of-window timestamps are rejected (T12)", () => {
  const state = createGatewayState();
  const { instance, accessToken } = enrolled(state);
  const fixed = nonce();
  const request = { instanceId: instance.instanceId, accessToken, nonce: fixed, ts: T0 };
  authenticateRequest(state, request, { now: T0 });
  assert.throws(() => authenticateRequest(state, request, { now: T0 + 1 }), /request_replayed/);
  assert.throws(() => authenticateRequest(state, { ...request, nonce: nonce(), ts: T0 - DEFAULTS.clockSkewMs - 1 }, { now: T0 }), /request_timestamp_out_of_window/);
  assert.throws(() => authenticateRequest(state, { ...request, nonce: "short", ts: T0 }, { now: T0 }), /request_nonce_invalid/);
  const muchLater = T0 + 3 * DEFAULTS.clockSkewMs;
  refreshAccessToken(state, instance.instanceId, { now: muchLater, random });
  assert.equal(Object.keys(state.nonces).length, 1);
  assert.throws(() => authenticateRequest(state, { ...request, ts: muchLater }, { now: muchLater }), /access_token_invalid/, "old token rotated; nonce cache pruned without allowing replays");
});

test("scope comes from the invitation; instances cannot widen it (T13)", () => {
  const state = createGatewayState();
  const { code } = issueInvite(state, { relayAccountId: "relay-1", chatId: chatA }, { now: T0, random });
  const result = enrollInstance(state, { code, instancePublicKey: "pk", relayAccountId: "relay-9", chatId: chatB, allowedChatIds: [chatB] }, { now: T0, random });
  assert.equal(result.instance.relayAccountId, "relay-1");
  assert.deepEqual(result.instance.allowedChatIds, [chatA]);
  const authed = authenticateRequest(state, { instanceId: result.instance.instanceId, accessToken: result.accessToken, nonce: nonce(), ts: T0 }, { now: T0 });
  authed.allowedChatIds.push(chatB);
  assert.deepEqual(state.instances[0].allowedChatIds, [chatA], "public views are copies");
  assert.equal(authorizeSend(state.instances[0], chatA), true);
  assert.throws(() => authorizeSend(state.instances[0], chatB), /chat_not_allowed/);
});

test("a chat has at most one active owner and inbound reaches only that owner (T14)", () => {
  const state = createGatewayState();
  const first = enrolled(state, chatA);
  const second = enrolled(state, chatB);
  assert.throws(() => issueInvite(state, { relayAccountId: "relay-1", chatId: chatA }, { now: T0, random }), /chat_already_owned/);
  assert.equal(routeInbound(state, { relayAccountId: "relay-1", chatId: chatA }), first.instance.instanceId);
  assert.equal(routeInbound(state, { relayAccountId: "relay-1", chatId: chatB }), second.instance.instanceId);
  assert.equal(routeInbound(state, { relayAccountId: "relay-2", chatId: chatA }), null, "another relay account does not match");
  assert.equal(routeInbound(state, { relayAccountId: "relay-1", chatId: "unknown@g.example.test" }), null);
  revokeInstance(state, first.instance.instanceId, { now: T0 + 1 });
  assert.equal(routeInbound(state, { relayAccountId: "relay-1", chatId: chatA }), null, "revoked owners receive nothing");
  const reissued = enrolled(state, chatA, T0 + 2);
  assert.equal(routeInbound(state, { relayAccountId: "relay-1", chatId: chatA }), reissued.instance.instanceId);
});
