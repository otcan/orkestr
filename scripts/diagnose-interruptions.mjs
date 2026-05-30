#!/usr/bin/env node
import { analyzeInterruptionHistory } from "../packages/core/src/interruption-classifier.js";

function argValue(argv, flag, fallback = "") {
  const index = argv.indexOf(flag);
  if (index < 0) return fallback;
  return argv[index + 1] || fallback;
}

function sinceMsFromDays(value) {
  const days = Number(value || 0);
  if (!Number.isFinite(days) || days <= 0) return 0;
  return Date.now() - days * 24 * 60 * 60 * 1000;
}

function formatReport(report) {
  const lines = [];
  const summary = report.summary || {};
  lines.push(`Interruption records: ${summary.total || 0}`);
  lines.push(`Current errors: ${summary.errorCount || 0}`);
  if (summary.supersededCount) lines.push(`Superseded notices: ${summary.supersededCount}`);
  lines.push("");
  lines.push("By category:");
  const categories = Object.entries(summary.byCategory || {}).sort((a, b) => b[1] - a[1]);
  if (!categories.length) lines.push("- none");
  for (const [category, count] of categories) lines.push(`- ${category}: ${count}`);
  lines.push("");
  lines.push("By thread:");
  const threads = Object.entries(summary.byThread || {}).sort((a, b) => b[1] - a[1]).slice(0, 12);
  if (!threads.length) lines.push("- none");
  for (const [thread, count] of threads) lines.push(`- ${thread}: ${count}`);
  lines.push("");
  lines.push("Latest:");
  const latest = summary.latest || [];
  if (!latest.length) lines.push("- none");
  for (const item of latest) {
    const preview = String(item.text || "").replace(/\s+/g, " ").slice(0, 120);
    lines.push(`- ${item.createdAt || "-"} ${item.threadName || item.threadId}: ${item.category} - ${preview}`);
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  const argv = process.argv.slice(2);
  const env = { ...process.env };
  const home = argValue(argv, "--home");
  if (home) env.ORKESTR_HOME = home;
  const report = await analyzeInterruptionHistory(env, {
    includeSuperseded: argv.includes("--include-superseded"),
    sinceMs: sinceMsFromDays(argValue(argv, "--since-days")),
  });
  if (argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else process.stdout.write(formatReport(report));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
