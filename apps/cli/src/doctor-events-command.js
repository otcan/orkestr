import { requestJson } from "./api-client.js";

// `orkestr doctor events [--since 1h|6h|1d|<iso>] [--json]`: event counts by
// type and the top error codes of failing event types. Never prints message
// text, chat ids or targets.
export async function doctorEventsCommand(argv, ctx) {
  const index = argv.indexOf("--since");
  const since = index >= 0 && argv[index + 1] ? argv[index + 1] : "1h";
  const payload = await requestJson(`/api/system/events/summary?${new URLSearchParams({ since })}`, ctx);
  if (argv.includes("--json")) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else ctx.stdout.write(formatEventsDoctor(payload));
  return payload.ok ? 0 : 1;
}

const codes = (row) => (row.topCodes || []).map((item) => `${item.code} ×${item.count}`).join(", ");

export function formatEventsDoctor(payload = {}) {
  const lines = [
    `Events, last ${payload.window?.minutes ?? "?"} min: ${payload.total || 0} total${payload.truncated ? " (scan limit reached, older events not counted)" : ""}${payload.unparseable ? `, ${payload.unparseable} unparseable` : ""}`,
  ];
  const failures = payload.failures || [];
  lines.push(failures.length ? "  failures:" : "  failures: none");
  for (const row of failures) lines.push(`    ${row.count} ${row.type} (${row.perHour}/h)${row.topCodes?.length ? `  ${codes(row)}` : ""}`);
  const types = payload.types || [];
  if (types.length) {
    lines.push("  by type:");
    for (const row of types.slice(0, 15)) lines.push(`    ${row.count} ${row.type}`);
  }
  return `${lines.join("\n")}\n`;
}
