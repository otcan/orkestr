import { requestJson } from "./api-client.js";

// `orkestr doctor whatsapp --archive-stale-outbox [--older-than 7d] [--limit N]
//  [--apply] [--json]`: dry-run by default; --apply moves stale unresolved jobs
// to the terminal "archived" state. Never sends or replays messages.
function flagValue(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] || "" : "";
}

export async function doctorWhatsAppStaleOutboxCommand(argv, ctx) {
  if (argv.includes("--dry-run") && argv.includes("--apply")) throw new Error("Use either --dry-run or --apply, not both.");
  const body = {
    olderThan: flagValue(argv, "--older-than") || "7d",
    apply: argv.includes("--apply"),
    ...(flagValue(argv, "--limit") ? { limit: Number(flagValue(argv, "--limit")) } : {}),
    ...(flagValue(argv, "--reason") ? { reason: flagValue(argv, "--reason") } : {}),
    operator: "cli",
  };
  const payload = await requestJson("/api/connectors/whatsapp/outbox-maintenance/archive-stale", { ...ctx, body, timeoutMs: 600_000 });
  if (argv.includes("--json")) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else ctx.stdout.write(formatStaleOutboxArchive(payload));
  return payload.ok ? 0 : 1;
}

export function formatStaleOutboxArchive(payload = {}) {
  const lines = [
    `WhatsApp stale outbox ${payload.dryRun ? "dry-run (nothing changed)" : "archive"}: older than ${payload.olderThan} (last activity before ${payload.cutoff})`,
    `  scanned ${payload.scanned || 0} unresolved jobs, eligible ${payload.eligible || 0}, ${payload.dryRun ? "would archive" : "archived"} ${payload.dryRun ? payload.selected || 0 : payload.archived || 0} (limit ${payload.limit})`,
  ];
  for (const [state, entry] of Object.entries(payload.byState || {})) {
    lines.push(`  ${state}: ${entry.count} (oldest ${entry.oldest}, newest ${entry.newest})`);
  }
  const ages = Object.entries(payload.byAge || {}).map(([bucket, count]) => `${bucket} ${count}`).join(", ");
  if (ages) lines.push(`  by age: ${ages}`);
  const skipped = Object.entries(payload.skipped || {}).filter(([, count]) => count).map(([key, count]) => `${key} ${count}`).join(", ");
  if (skipped) lines.push(`  kept: ${skipped}`);
  if (payload.dryRun && payload.eligible) lines.push("  Re-run with --apply to archive. Archived jobs stay in the outbox (state \"archived\") and can be retried by job id.");
  if (!payload.dryRun && payload.remainingAfterRun > 0) lines.push(`  ${payload.remainingAfterRun} eligible jobs remain; re-run to continue.`);
  return `${lines.join("\n")}\n`;
}
