#!/usr/bin/env node
import { reportCodexQuestions } from "../packages/core/src/codex-question-audit.js";
import { saveRepairManifest } from "../packages/core/src/codex-input-repair.js";
import { isMainModule } from "./main-module.mjs";

export async function runQuestionAudit(argv = process.argv.slice(2), env = process.env) {
  if (!env.ORKESTR_HOME) throw new Error("question_audit_explicit_home_required");
  const allowed = new Set(["--thread", "--owner", "--generation", "--max-messages", "--report"]);
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i], value = argv[i + 1];
    if (!allowed.has(flag) || options[flag] || !value || value.startsWith("--")) throw new Error("question_audit_invalid_arguments");
    options[flag] = value;
  }
  if (!["--thread", "--owner", "--generation", "--report"].every(key => options[key])) throw new Error("question_audit_scope_required");
  const report = await reportCodexQuestions({ threadId: options["--thread"], ownerUserId: options["--owner"],
    runtimeGeneration: options["--generation"],
    maxMessages: options["--max-messages"] ? Number(options["--max-messages"]) : undefined }, env);
  await saveRepairManifest(options["--report"], report);
  return { dryRun: true, automaticMutation: false, scanned: report.scanned, counts: report.counts, snapshotDigest: report.snapshotDigest };
}

if (isMainModule(import.meta.url)) {
  runQuestionAudit().then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(/^[a-z][a-z0-9_]+$/.test(error.message || "") ? error.message : "question_audit_failed"); process.exitCode = 1;
  });
}
