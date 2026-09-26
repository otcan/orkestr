import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

// Source analysis for ORK-512 (Gmail OAuth intent+POST flow) and
// ORK-513 (WhatsApp repair admin + account-binding hardening).
// These tests verify security-critical invariants in the connector controller
// without requiring a full server start or Google/WhatsApp credentials.

const CTRL = "apps/server/src/modules/connectors/connectors.controller.ts";

// ORK-512: Gmail OAuth intent creation

test("ORK-512: POST gmail/oauth/intent passes all binding fields into the intent", async () => {
  const source = await fs.readFile(CTRL, "utf8");
  assert.match(source, /@Post\("gmail\/oauth\/intent"\)/);
  // All binding fields (accountId, capabilities, returnTarget) must be passed at intent creation.
  assert.match(source, /connector: "gmail", purpose: "oauth_start", host, accountId, capabilities, returnTarget/);
  // createConnectorUseIntent is used (not a raw store).
  assert.match(source, /createConnectorUseIntent/);
});

// ORK-512: Gmail OAuth start intent consumption with account binding

test("ORK-512: POST gmail/oauth/start consumes intent with accountId to block account substitution", async () => {
  const source = await fs.readFile(CTRL, "utf8");
  assert.match(source, /@Post\("gmail\/oauth\/start"\)/);
  assert.match(source, /consumeConnectorUseIntent/);
  // Account substitution guard: accountId passed at consumption must match what was bound in the intent.
  assert.match(source, /accountId: account\.toLowerCase\(\)/);
});

// ORK-512: GET /oauth/gmail/start must require admin — no anonymous browser launches

test("ORK-512: GET /oauth/gmail/start in ConnectorCallbacksController requires admin principal", async () => {
  const source = await fs.readFile(CTRL, "utf8");
  assert.match(source, /class ConnectorCallbacksController/);
  assert.match(source, /@Get\("gmail\/start"\)/);
  // Admin check must be present; unauthenticated callers receive a 403.
  assert.match(source, /authentication_required/);
  // The check uses isAdminPrincipal (same pattern as all other admin-only routes).
  const callbacksStart = source.indexOf("class ConnectorCallbacksController");
  const gmailStartSection = source.slice(callbacksStart);
  assert.match(gmailStartSection, /if \(!isAdminPrincipal\(principal\)\)/);
});

// ORK-513: WhatsApp repair page — admin only

test("ORK-513: GET whatsapp/bridge/repair requires admin principal and returns 403 to others", async () => {
  const source = await fs.readFile(CTRL, "utf8");
  assert.match(source, /@Get\("whatsapp\/bridge\/repair"\)/);
  // Extract the repair page handler section (between the two decorators).
  const repairIdx = source.indexOf('@Get("whatsapp/bridge/repair")');
  const sendEmailIdx = source.indexOf('@Post("whatsapp/bridge/repair/send-email")');
  assert.ok(repairIdx > 0 && sendEmailIdx > repairIdx, "repair page and send-email endpoints must both exist");
  const repairSection = source.slice(repairIdx, sendEmailIdx);
  // Admin check must be present in the repair page handler.
  assert.match(repairSection, /isAdminPrincipal\(principal\)/);
  // Returns 403 to non-admin callers.
  assert.match(repairSection, /\.status\(403\)/);
  // The accountId is bound into the one-time intent at page-load time.
  assert.match(repairSection, /createConnectorUseIntent/);
  assert.match(repairSection, /accountId: String\(accountId/);
});

// ORK-513: WhatsApp repair send-email — admin + account binding from intent

test("ORK-513: POST whatsapp/bridge/repair/send-email requires admin and reads accountId from intent only", async () => {
  const source = await fs.readFile(CTRL, "utf8");
  assert.match(source, /@Post\("whatsapp\/bridge\/repair\/send-email"\)/);
  // Admin is strictly required regardless of intent state.
  assert.match(source, /throw httpError\("admin_required", 403\)/);
  // accountId must come from the consumed intent, not from the request body.
  assert.match(source, /const boundAccountId = String\(consumed\?\.accountId \|\| ""\)\.trim\(\)/);
  // Generic error on intent failure — no disclosure of intent state to the caller.
  assert.match(source, /throw httpError\("repair_intent_required", 401\)/);
  // Generic error on repair failure — no account/recipient disclosure.
  assert.match(source, /throw httpError\("repair_unavailable", 503\)/);
  // Recipients in the response must be masked.
  assert.match(source, /result\.recipients.*map\(maskEmail\)/);
});
