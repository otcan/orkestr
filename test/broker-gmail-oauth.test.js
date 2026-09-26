import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

// ORK-512: Source analysis verifying the broker proxy handles the new intent+POST
// Gmail OAuth flow while keeping the legacy GET flow for backward compatibility.
// The broker must handle these requests in-process (not proxied to the tenant VM)
// because only the parent instance can perform the actual OAuth.

const PROXY_SOURCE = "apps/server/src/broker-instance-app-proxy.ts";

test("broker proxy intercepts POST /api/connectors/gmail/oauth/intent for in-process handling (ORK-512)", async () => {
  const source = await fs.readFile(PROXY_SOURCE, "utf8");
  // The intent interceptor function must exist.
  assert.match(source, /brokerGoogleWorkspaceIntentRequest/);
  assert.match(source, /handleBrokerGoogleWorkspaceIntent/);
  // It must match the exact intent path.
  assert.match(source, /"\/api\/connectors\/gmail\/oauth\/intent"/);
  // It must require POST — non-POST is rejected early.
  assert.match(source, /!== "POST"/);
  // The session must have a Google connect authIntent before an in-process broker intent is issued.
  assert.match(source, /authIntentAllowsGoogleConnect\(session, route\.instanceId\)/);
  // The response must be 201 with intentId and token.
  assert.match(source, /sendJson\(response, 201,/);
});

test("broker proxy validates one-time broker-scoped intent on POST /api/connectors/gmail/oauth/start (ORK-512)", async () => {
  const source = await fs.readFile(PROXY_SOURCE, "utf8");
  // Both error codes must be present for missing and invalid intents.
  assert.match(source, /broker_oauth_intent_required/);
  assert.match(source, /broker_oauth_intent_invalid/);
  // Timing-safe comparison must be used for the broker intent token.
  assert.match(source, /crypto\.timingSafeEqual/);
  // The intent must be consumed (single-use) after successful validation.
  assert.match(source, /brokerOAuthIntents\.delete\(intentId\)/);
  // instanceId must be validated — reject intents issued for a different broker instance.
  assert.match(source, /brokerIntent\.instanceId !== route\.instanceId/);
});

test("broker proxy GET /api/connectors/gmail/oauth/start still works for backward compatibility (ORK-512)", async () => {
  const source = await fs.readFile(PROXY_SOURCE, "utf8");
  // brokerGoogleWorkspaceStartRequest must accept both GET and POST.
  assert.match(source, /method !== "GET" && method !== "POST"/);
  // GET path reads OAuth params from query string; POST reads from request body.
  assert.match(source, /parsed\.searchParams/);
  assert.match(source, /request\?\.body/);
  // The comment explicitly documents GET as legacy/backward-compat.
  assert.match(source, /legacy.*backward.compat|backward.compat.*legacy/);
});

test("broker proxy intent and start handlers are wired before proxying upstream (ORK-512)", async () => {
  const source = await fs.readFile(PROXY_SOURCE, "utf8");
  const intentCall = "await handleBrokerGoogleWorkspaceIntent(request, response, route)";
  const startCall = "await handleBrokerGoogleWorkspaceStart(request, response, route)";
  assert.ok(source.includes(intentCall), "handleBrokerGoogleWorkspaceIntent must be called in the proxy dispatch");
  assert.ok(source.includes(startCall), "handleBrokerGoogleWorkspaceStart must be called in the proxy dispatch");
  // Intent handler is wired before the start handler so the intent is available at start time.
  assert.ok(source.indexOf(intentCall) < source.indexOf(startCall), "intent handler must precede start handler in dispatch");
});

test("broker proxy OAuth intent store uses TTL and prunes expired entries (ORK-512)", async () => {
  const source = await fs.readFile(PROXY_SOURCE, "utf8");
  // TTL constant and prune function must be present.
  assert.match(source, /BROKER_INTENT_TTL_MS/);
  assert.match(source, /pruneBrokerOAuthIntents/);
  // Expiry is enforced at consumption time, not just at creation.
  assert.match(source, /expiresAt <= Date\.now\(\)/);
});
