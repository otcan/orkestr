import { listThreads, updateThread } from "../../core/src/threads.js";
import {
  readWhatsAppBindingRecords,
  updateWhatsAppBindingRecord,
} from "./whatsapp-binding-registry.js";
import {
  legacyWhatsAppParticipantIdentityConfig,
  whatsappParticipantIdentityV2Enabled,
} from "./whatsapp-participant-identity.js";

function clean(value = "") {
  return String(value || "").trim();
}

function whatsappBinding(binding = {}) {
  return clean(binding.connector || "whatsapp").toLowerCase() === "whatsapp" && Boolean(clean(binding.chatId) || clean(binding.id || binding.bindingId));
}

function migrationMarker(binding = {}) {
  return binding.participantIdentityMigrationV2 && typeof binding.participantIdentityMigrationV2 === "object" && !Array.isArray(binding.participantIdentityMigrationV2)
    ? binding.participantIdentityMigrationV2
    : null;
}

export function planWhatsAppParticipantIdentityMigration(binding = {}, options = {}) {
  const mode = clean(options.mode || "dry-run").toLowerCase();
  const now = clean(options.now) || new Date().toISOString();
  if (!["dry-run", "apply", "rollback"].includes(mode)) {
    const error = new Error("wa_participant_identity_migration_mode_invalid");
    error.statusCode = 400;
    throw error;
  }
  const marker = migrationMarker(binding);
  if (mode === "rollback") {
    if (!marker) return { action: "unchanged", reason: "not_migrated", binding };
    return {
      action: "rollback",
      reason: "restore_pre_migration_identity",
      binding: {
        ...binding,
        participantIdentityV2: marker.previousParticipantIdentityV2 || null,
        participantIdentityMigrationV2: null,
        participantIdentityV2Rollback: {
          version: 2,
          rolledBackAt: now,
          revision: clean(binding.participantIdentityV2?.revision),
        },
      },
    };
  }
  if (marker || binding.participantIdentityV2) {
    return { action: "unchanged", reason: marker ? "already_migrated" : "explicit_v2_config", binding };
  }
  const config = legacyWhatsAppParticipantIdentityConfig(binding);
  if (!config) return { action: "skipped", reason: "no_explicit_legacy_participant_aliases", binding };
  return {
    action: mode === "dry-run" ? "would_apply" : "apply",
    reason: "explicit_legacy_aliases",
    binding: {
      ...binding,
      participantIdentityV2: config,
      participantIdentityMigrationV2: {
        version: 2,
        source: "explicit_legacy_aliases",
        appliedAt: now,
        previousParticipantIdentityV2: null,
      },
      participantIdentityV2Rollback: null,
    },
  };
}

export async function migrateWhatsAppParticipantIdentityBindings(options = {}) {
  const env = options.env || process.env;
  const mode = clean(options.mode || "dry-run").toLowerCase();
  if (!["dry-run", "apply", "rollback"].includes(mode)) {
    const error = new Error("wa_participant_identity_migration_mode_invalid");
    error.statusCode = 400;
    throw error;
  }
  if (mode === "apply" && !whatsappParticipantIdentityV2Enabled(env)) {
    const error = new Error("wa_participant_identity_v2_flag_required");
    error.statusCode = 409;
    throw error;
  }
  const [threads, records] = await Promise.all([listThreads(env), readWhatsAppBindingRecords(env)]);
  const targets = [
    ...threads.filter((thread) => whatsappBinding(thread.binding || {})).map((thread) => ({ source: "thread", id: thread.id, binding: thread.binding || {} })),
    ...records.filter(whatsappBinding).map((binding) => ({ source: "registry", id: clean(binding.id || binding.bindingId), binding })),
  ];
  const plans = targets.map((target) => {
    try {
      return { target, plan: planWhatsAppParticipantIdentityMigration(target.binding, { mode, now: options.now }) };
    } catch (error) {
      return { target, error };
    }
  });
  const results = plans.map(({ target, plan, error }) => error ? {
    source: target.source,
    id: target.id,
    action: "invalid",
    reason: clean(error?.message || "wa_participant_identity_invalid"),
    diagnostics: error?.diagnostics || null,
    revision: "",
  } : {
      source: target.source,
      id: target.id,
      action: plan.action,
      reason: plan.reason,
      revision: clean(plan.binding.participantIdentityV2?.revision),
  });
  const invalid = results.filter((result) => result.action === "invalid");
  if (mode !== "dry-run" && invalid.length) {
    const error = new Error("wa_participant_identity_migration_preflight_failed");
    error.statusCode = 409;
    error.diagnostics = { invalid };
    throw error;
  }
  for (const { target, plan } of plans) {
    if (!["apply", "rollback"].includes(plan?.action)) continue;
    if (target.source === "thread") {
      await updateThread(target.id, { binding: plan.binding }, env);
    } else {
      await updateWhatsAppBindingRecord(target.id, plan.binding, env);
    }
  }
  return {
    ok: invalid.length === 0,
    mode,
    dryRun: mode === "dry-run",
    inspected: targets.length,
    changed: results.filter((result) => ["apply", "rollback", "would_apply"].includes(result.action)).length,
    invalid: invalid.length,
    results,
  };
}
