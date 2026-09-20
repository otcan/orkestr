import { parseArgs } from "node:util";
import { retainOutboundStagingJournals } from "../packages/connectors/src/outbound-staging-retention.js";

const { values } = parseArgs({ options: {
  thread: { type: "string" }, owner: { type: "string" },
  "min-age-days": { type: "string", default: "7" },
  limit: { type: "string", default: "100" }, after: { type: "string", default: "" },
  apply: { type: "boolean", default: false },
  "confirm-quarantine": { type: "string" }, help: { type: "boolean", default: false },
} });

if (values.help) {
  console.log("Usage: node scripts/outbound-staging-retention.mjs --thread <id> --owner <id> [--min-age-days 7] [--limit 100] [--after <journal-id>]");
  console.log("Default: report only. Quarantine requires --apply --confirm-quarantine <thread-id> and coordinated fenced writers. Never deletes attachment bytes.");
} else {
  try {
    if (!process.env.ORKESTR_HOME || !values.thread || !values.owner) throw new Error("explicit_home_thread_owner_required");
    if (values.apply && values["confirm-quarantine"] !== values.thread) throw new Error("exact_thread_confirmation_required");
    const result = await retainOutboundStagingJournals({
      threadId: values.thread, ownerUserId: values.owner, apply: values.apply,
      minAgeMs: Number(values["min-age-days"]) * 86400_000, maxItems: Number(values.limit), afterId: values.after,
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    // Avoid exposing private paths or inventory contents in operator logs.
    const message = String(error.message || "");
    console.error(/^[a-z][a-z0-9_]+$/.test(message) ? message : "staging_retention_failed");
    process.exitCode = 1;
  }
}
