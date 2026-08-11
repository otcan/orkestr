import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeWhatsAppBinding } from "../packages/connectors/src/whatsapp-account-bindings.js";
import { evaluateWhatsAppInboundSecurity } from "../packages/connectors/src/whatsapp-inbound-security.js";
import { routeWhatsAppInbound } from "../packages/connectors/src/whatsapp.js";
import {
  normalizeWhatsAppParticipantIdentityConfig,
  resolveWhatsAppParticipantIdentity,
} from "../packages/connectors/src/whatsapp-participant-identity.js";
import { migrateWhatsAppParticipantIdentityBindings, planWhatsAppParticipantIdentityMigration } from "../packages/connectors/src/whatsapp-participant-identity-migration.js";
import { createAndBindWhatsAppThreadGroup } from "../packages/connectors/src/whatsapp-thread-groups.js";
import { createThread, getThread, listThreadMessages, updateThread } from "../packages/core/src/threads.js";

const env = { ORKESTR_WHATSAPP_PARTICIPANT_IDENTITY_V2: "1" };

function binding() {
  return {
    connector: "whatsapp",
    chatId: "synthetic-team@g.us",
    senderAccountId: "wa-receiver",
    responderAccountId: "wa-receiver",
    outboundAccountId: "wa-receiver",
    participantIdentityV2: {
      version: 2,
      accountId: "wa-receiver",
      identities: [
        {
          id: "person-owner",
          aliases: [
            { kind: "phone", value: "+15550100001", verified: true },
            { kind: "jid", value: "15550100001@c.us", verified: true },
            { kind: "lid", value: "90000000000001@lid", verified: true },
          ],
        },
        { id: "person-trusted", aliases: [{ kind: "jid", value: "15550100002@c.us", verified: true }] },
        { id: "person-blocked", aliases: [{ kind: "jid", value: "15550100003@c.us", verified: true }] },
      ],
      grants: [
        { identityId: "person-owner", role: "owner" },
        { identityId: "person-trusted", role: "trusted" },
        { identityId: "person-blocked", role: "owner" },
        { identityId: "person-blocked", role: "blocked" },
      ],
    },
  };
}

test("WhatsApp participant V2 resolves verified phone, JID, and LID aliases to one scoped owner", () => {
  const source = binding();
  for (const senderId of ["+1 (555) 010-0001", "15550100001@s.whatsapp.net", "90000000000001@lid"]) {
    const resolved = resolveWhatsAppParticipantIdentity(source, { accountId: "wa-receiver", senderId }, env);
    assert.equal(resolved.identityId, "person-owner");
    assert.equal(resolved.effectiveRole, "owner");
  }
  const wrongAccount = resolveWhatsAppParticipantIdentity(source, { accountId: "different-receiver", senderId: "15550100001@c.us" }, env);
  assert.equal(wrongAccount.effectiveRole, "unknown");
  assert.equal(wrongAccount.reason, "account_scope_mismatch");
});

test("WhatsApp participant V2 preserves blocked > owner > trusted > unknown and operational owner policy", () => {
  const source = binding();
  const decide = (from, text) => evaluateWhatsAppInboundSecurity({
    binding: source,
    input: { accountId: "wa-receiver", chatId: source.chatId, from, text },
    env,
  });

  const owner = decide("90000000000001@lid", "run the deployment check");
  const trusted = decide("15550100002@c.us", "run the deployment check");
  const unknown = decide("15550100009@c.us", "run the deployment check");
  const blocked = decide("15550100003@c.us", "hello");

  assert.equal(owner.allowed, true);
  assert.equal(owner.effectiveRole, "owner");
  assert.equal(trusted.allowed, false);
  assert.equal(trusted.effectiveRole, "trusted");
  assert.equal(trusted.reason, "host_execution");
  assert.equal(unknown.allowed, false);
  assert.equal(unknown.effectiveRole, "unknown");
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.effectiveRole, "blocked");
});

test("WhatsApp participant V2 fails closed on alias collisions and owner/trusted overlap", () => {
  const collision = binding();
  collision.participantIdentityV2.identities.push({
    id: "person-collision",
    aliases: [{ kind: "phone", value: "+15550100001", verified: true }],
  });
  collision.participantIdentityV2.grants.push({ identityId: "person-collision", role: "trusted" });
  assert.throws(() => normalizeWhatsAppParticipantIdentityConfig(collision), /wa_participant_identity_alias_collision/);

  const overlap = binding();
  overlap.participantIdentityV2.grants.push({ identityId: "person-owner", role: "trusted" });
  assert.throws(() => normalizeWhatsAppParticipantIdentityConfig(overlap), /wa_participant_identity_owner_trusted_overlap/);

  const unverified = binding();
  unverified.participantIdentityV2.identities[0].aliases = [{ kind: "phone", value: "+15550100001", verified: false }];
  assert.throws(() => normalizeWhatsAppParticipantIdentityConfig(unverified), /wa_participant_identity_verified_alias_required/);
});

test("WhatsApp binding status keeps owner and trusted aliases distinct", () => {
  const normalized = normalizeWhatsAppBinding(binding(), {
    env,
    accounts: [{ accountId: "wa-receiver", ready: true }],
  });
  assert.equal(normalized.participantIdentity.valid, true);
  assert.equal(normalized.ownerParticipantAliases.length, 3);
  assert.deepEqual(normalized.trustedParticipantAliases, [{ kind: "jid", value: "15550100002@c.us" }]);
  assert.deepEqual(normalized.blockedParticipantAliases, [{ kind: "jid", value: "15550100003@c.us" }]);
});

test("WhatsApp V2 routes operational owner text and terminally denies identical trusted and unknown text", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-participant-route-"));
  const routeEnv = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_PARTICIPANT_IDENTITY_V2: "1",
    ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED: "1",
    ORKESTR_WHATSAPP_API_AGENT_AUTORUN: "0",
  };
  await createThread({ id: "participant-route-thread", name: "Synthetic V2 route", binding: binding() }, routeEnv);
  const text = "run the deterministic host check";

  const owner = await routeWhatsAppInbound({
    eventId: "participant-owner-event",
    accountId: "wa-receiver",
    chatId: "synthetic-team@g.us",
    from: "90000000000001@lid",
    text,
  }, routeEnv);
  await assert.rejects(
    routeWhatsAppInbound({
      eventId: "participant-trusted-event",
      accountId: "wa-receiver",
      chatId: "synthetic-team@g.us",
      from: "15550100002@c.us",
      text,
    }, routeEnv),
    (error) => {
      assert.equal(error.routingFailure.effectiveRole, "trusted");
      assert.equal(error.routingFailure.classification, "host_execution");
      assert.equal(error.routingFailure.retryable, false);
      return true;
    },
  );
  const duplicateRejected = await routeWhatsAppInbound({
    eventId: "participant-trusted-event",
    accountId: "wa-receiver",
    chatId: "synthetic-team@g.us",
    from: "15550100002@c.us",
    text,
  }, routeEnv);
  await assert.rejects(
    routeWhatsAppInbound({
      eventId: "participant-unknown-event",
      accountId: "wa-receiver",
      chatId: "synthetic-team@g.us",
      from: "15550100009@c.us",
      text,
    }, routeEnv),
    (error) => {
      assert.equal(error.routingFailure.effectiveRole, "unknown");
      assert.equal(error.routingFailure.retryable, false);
      return true;
    },
  );

  const messages = await listThreadMessages("participant-route-thread", routeEnv);
  assert.equal(owner.threadId, "participant-route-thread");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].senderEffectiveRole, "owner");
  assert.equal(duplicateRejected.outcome, "duplicate_rejected");
  assert.equal(duplicateRejected.rejected, true);
});

test("WhatsApp participant migration supports dry-run, apply, repeat, rollback, and reapply", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-participant-migration-"));
  const migrationEnv = { ORKESTR_HOME: home, ORKESTR_WHATSAPP_PARTICIPANT_IDENTITY_V2: "1" };
  await createThread({
    id: "participant-migration-thread",
    name: "Synthetic participant migration",
    binding: {
      connector: "whatsapp",
      chatId: "migration@g.us",
      senderAccountId: "wa-receiver",
      responderAccountId: "wa-receiver",
      senderContactId: "15550100001@c.us",
      ownerContactAliases: ["90000000000001@lid"],
      additionalParticipantsEnabled: true,
      additionalParticipantIds: ["15550100002@c.us"],
    },
  }, migrationEnv);

  const dryRun = await migrateWhatsAppParticipantIdentityBindings({ mode: "dry-run", env: migrationEnv, now: "2026-08-11T10:00:00.000Z" });
  assert.equal(dryRun.results[0].action, "would_apply");
  assert.equal((await getThread("participant-migration-thread", migrationEnv)).binding.participantIdentityV2, undefined);

  const applied = await migrateWhatsAppParticipantIdentityBindings({ mode: "apply", env: migrationEnv, now: "2026-08-11T10:00:00.000Z" });
  const repeated = await migrateWhatsAppParticipantIdentityBindings({ mode: "apply", env: migrationEnv, now: "2026-08-11T10:01:00.000Z" });
  assert.equal(applied.results[0].action, "apply");
  assert.equal(repeated.results[0].action, "unchanged");

  const rollback = await migrateWhatsAppParticipantIdentityBindings({ mode: "rollback", env: migrationEnv, now: "2026-08-11T10:02:00.000Z" });
  const rolledBack = await getThread("participant-migration-thread", migrationEnv);
  assert.equal(rollback.results[0].action, "rollback");
  assert.equal(rolledBack.binding.participantIdentityV2, null);
  assert.equal(rolledBack.binding.senderContactId, "15550100001@c.us");

  const reapplied = await migrateWhatsAppParticipantIdentityBindings({ mode: "apply", env: migrationEnv, now: "2026-08-11T10:03:00.000Z" });
  assert.equal(reapplied.results[0].action, "apply");
});

test("WhatsApp group provisioning dual-writes only explicit owner aliases behind V2", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-participant-provision-"));
  const provisionEnv = { ORKESTR_HOME: home, ORKESTR_WHATSAPP_PARTICIPANT_IDENTITY_V2: "1" };
  const thread = await createThread({ id: "participant-provision-thread", name: "Synthetic provisioning" }, provisionEnv);
  const result = await createAndBindWhatsAppThreadGroup(thread, {
    senderAccountId: "wa-receiver",
    responderAccountId: "wa-receiver",
    participantIds: ["15550100002@c.us"],
  }, provisionEnv, {
    createChat: async () => ({
      chat: { id: "provisioned@g.us", name: "Synthetic provisioning" },
      senderAccountId: "wa-receiver",
      responderAccountId: "wa-receiver",
      senderContactId: "15550100001@c.us",
      responderContactId: "15550999999@c.us",
    }),
    updateThread,
  });
  const status = normalizeWhatsAppParticipantIdentityConfig(result.binding);
  assert.equal(status.identities.length, 1);
  assert.deepEqual(status.grants.map((grant) => grant.role), ["owner"]);
  assert.equal(status.identities[0].aliases[0].value, "15550100001@c.us");
  assert.equal(status.identities.some((identity) => identity.aliases.some((alias) => alias.value === "15550100002@c.us")), false);
});

test("WhatsApp participant migration never infers ownership from group membership", () => {
  const groupOnly = {
    connector: "whatsapp",
    chatId: "group-only@g.us",
    senderAccountId: "wa-receiver",
    responderAccountId: "wa-receiver",
    participantIds: ["15550100001@c.us"],
  };
  const migration = planWhatsAppParticipantIdentityMigration(groupOnly, { mode: "dry-run", now: "2026-08-11T10:00:00.000Z" });
  assert.equal(migration.action, "skipped");
  assert.equal(migration.reason, "no_explicit_legacy_participant_aliases");
  assert.equal(resolveWhatsAppParticipantIdentity(groupOnly, { accountId: "wa-receiver", senderId: "15550100001@c.us" }, env).enabled, false);
});

test("WhatsApp participant migration preflights every binding before apply", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-participant-preflight-"));
  const migrationEnv = { ORKESTR_HOME: home, ORKESTR_WHATSAPP_PARTICIPANT_IDENTITY_V2: "1" };
  await createThread({
    id: "participant-preflight-valid",
    binding: { connector: "whatsapp", chatId: "valid@g.us", senderAccountId: "wa-receiver", senderContactId: "15550100001@c.us" },
  }, migrationEnv);
  await createThread({
    id: "participant-preflight-invalid",
    binding: {
      connector: "whatsapp",
      chatId: "invalid@g.us",
      senderAccountId: "wa-receiver",
      senderContactId: "15550100002@c.us",
      additionalParticipantsEnabled: true,
      additionalParticipantIds: ["15550100002@c.us"],
    },
  }, migrationEnv);

  const dryRun = await migrateWhatsAppParticipantIdentityBindings({ mode: "dry-run", env: migrationEnv });
  assert.equal(dryRun.ok, false);
  assert.equal(dryRun.invalid, 1);
  assert.equal(dryRun.results.find((result) => result.id === "participant-preflight-invalid").reason, "wa_participant_identity_owner_trusted_overlap");
  await assert.rejects(
    migrateWhatsAppParticipantIdentityBindings({ mode: "apply", env: migrationEnv }),
    /wa_participant_identity_migration_preflight_failed/,
  );
  assert.equal((await getThread("participant-preflight-valid", migrationEnv)).binding.participantIdentityV2, undefined);
});
