import { requestJson } from "./api-client.js";

// `orkestr doctor voice`: voice-note transcription health (docs/voice-notes.md).
export async function doctorVoiceCommand(argv, ctx) {
  const payload = await requestJson("/api/voice-transcription/status", ctx);
  if (argv.includes("--json")) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else ctx.stdout.write(formatVoiceDoctor(payload));
  return payload.ok ? 0 : 1;
}

function minutes(seconds = 0) {
  return `${(Math.max(0, Number(seconds) || 0) / 60).toFixed(1)} min`;
}

function codes(entry = {}) {
  const list = Object.entries(entry.codes || {}).sort((left, right) => right[1] - left[1]).map(([code, count]) => `${code} ×${count}`);
  return list.length ? ` (${list.join(", ")})` : "";
}

export function formatVoiceDoctor(payload = {}) {
  const today = payload.today || {};
  const week = payload.last7Days || {};
  const lines = [
    `Voice transcription: ${String(payload.status || "unknown").toUpperCase()}`,
    `  mode ${payload.mode || "?"} · model ${payload.model || "?"} · languages ${(payload.languages || []).join(", ") || "auto"}`,
    `  API key ${payload.keyConfigured ? `configured (${payload.keySource})` : "missing"}`,
    `  spend today $${Number(payload.spentTodayUsd || 0).toFixed(4)} of $${Number(payload.dailyBudgetUsd || 0).toFixed(2)} · limit ${payload.chatHourlyLimit || "?"} notes/hour per chat`,
    `  today ${today.completed || 0} transcribed (${minutes(today.seconds)}), ${today.failed || 0} failed${codes(today)}`,
    `  last 7 days ${week.completed || 0} transcribed (${minutes(week.seconds)}), ${week.failed || 0} failed${codes(week)}`,
    `  last success ${payload.lastSuccessAt || "never"}${payload.lastFailure ? ` · last failure ${payload.lastFailure.at} (${payload.lastFailure.code})` : ""}`,
  ];
  for (const problem of payload.problems || []) lines.push(`  ✗ ${problem}`);
  for (const warning of payload.warnings || []) lines.push(`  ! ${warning}`);
  return `${lines.join("\n")}\n`;
}
