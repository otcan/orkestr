import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

test("WhatsApp participant identity migration controller is admin-only and exposes explicit modes", async () => {
  const [controller, moduleSource] = await Promise.all([
    fs.readFile("apps/server/src/modules/connectors/whatsapp-participant-identity.controller.ts", "utf8"),
    fs.readFile("apps/server/src/modules/connectors/connectors.module.ts", "utf8"),
  ]);
  assert.match(controller, /@Controller\("api\/connectors\/whatsapp\/participant-identities"\)/);
  assert.match(controller, /@Post\("migrate"\)/);
  assert.match(controller, /if \(!isAdminPrincipal\(requestPrincipal\(request\)\)\) throw httpError\("admin_required", 403\)/);
  assert.match(controller, /mode: String\(body\.mode \|\| "dry-run"\)/);
  assert.match(controller, /migrateWhatsAppParticipantIdentityBindings/);
  assert.match(controller, /diagnostics: \(error as any\)\?\.diagnostics \|\| null/);
  assert.match(moduleSource, /WhatsAppParticipantIdentityController/);
});

test("connector gateway reserves explicit WhatsApp replay for the operator token", async () => {
  const source = await fs.readFile("scripts/orkestr-connectors-mcp.mjs", "utf8");
  assert.match(source, /app\.post\("\/internal\/whatsapp\/inbound\/:eventId\/replay"/);
  assert.match(source, /if \(!legacyTokenAllowed\(req, env\)\) return res\.status\(401\)\.json\(\{ ok: false, error: "connector_mcp_operator_token_required" \}\)/);
  assert.match(source, /replayConnectorInboxEvent\(req\.params\.eventId/);
});

test("thread action sanitizer receives only redacted participant identity metadata", async () => {
  const source = await fs.readFile("apps/server/src/modules/threads/thread-route-helpers.ts", "utf8");
  assert.match(source, /result\.participantIdentityV2 = \{/);
  assert.match(source, /identityCount: identities\.length/);
  assert.match(source, /verifiedAliasCount:/);
  assert.match(source, /grantRoles:/);
  assert.doesNotMatch(source, /result\.participantIdentityV2 = participantIdentity/);
});
