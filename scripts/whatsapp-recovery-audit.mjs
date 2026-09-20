#!/usr/bin/env node
import { reportWhatsAppRecovery } from "../packages/connectors/src/whatsapp-recovery-audit.js";
import { saveRepairManifest } from "../packages/core/src/codex-input-repair.js";
import { isMainModule } from "./main-module.mjs";

export async function runRecoveryAudit(argv = process.argv.slice(2), env = process.env) {
  if (!env.ORKESTR_HOME) throw new Error("recovery_audit_explicit_home_required");
  const flags = { "--thread": "threadId", "--owner": "ownerUserId", "--account": "accountId", "--chat": "chatId",
    "--generation": "runtimeGeneration", "--since": "since", "--until": "until", "--report": "reportPath" };
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const field = flags[argv[i]], value = argv[i + 1];
    if (!field || options[field] || !value || value.startsWith("--")) throw new Error("recovery_audit_invalid_arguments");
    options[field] = value;
  }
  if (!Object.values(flags).every(key => options[key])) throw new Error("recovery_audit_scope_required");
  const { reportPath, ...scope } = options;
  const report = await reportWhatsAppRecovery(scope, env);
  await saveRepairManifest(reportPath, report);
  return { dryRun: true, automaticReplay: false, complete: report.complete, counts: report.counts, snapshotDigest: report.snapshotDigest };
}

if (isMainModule(import.meta.url)) {
  runRecoveryAudit().then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(/^[a-z][a-z0-9_]+$/.test(error.message || "") ? error.message : "recovery_audit_failed"); process.exitCode = 1;
  });
}
