import { requestJson } from "./api-client.js";

function flag(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] || "" : "";
}

// `orkestr doctor codex`: Codex login state and recent auth-rejected turns.
export async function doctorCodexCommand(argv, ctx) {
  const payload = await requestJson("/api/system/codex-auth", ctx);
  if (argv.includes("--json")) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else ctx.stdout.write(formatCodexAuthDoctor(payload));
  return payload.ok ? 0 : 1;
}

export function formatCodexAuthDoctor(payload = {}) {
  const login = payload.login || {};
  const health = payload.health || {};
  const lines = [
    `Codex auth: ${payload.ok ? "OK" : "BROKEN"}`,
    `  login ${login.connected ? `connected${login.authMode ? ` (${login.authMode})` : ""}` : `not connected (${login.reason || "unknown"})`}`,
    `  runtime health ${health.state || "unknown"}${health.lastFailureAt ? ` · last failure at ${health.lastFailureAt} (${health.reason || "?"})` : ""}${health.recoveredAt ? `, recovered at ${health.recoveredAt}` : ""}`,
    `  auth-failed turns in last 24h: ${payload.recentFailures || 0}${payload.failedThreads?.length ? ` · threads ${payload.failedThreads.join(", ")}` : ""}`,
  ];
  if (payload.alertedAt) lines.push(`  owner alerted at ${payload.alertedAt}`);
  if (payload.fix) lines.push(`  fix: log in again: ${payload.fix}`, "  then: orkestr threads retry-failed --since 2h");
  return `${lines.join("\n")}\n`;
}

export function retryText(turn = {}) {
  const quoted = String(turn.text || "").split("\n").map((line) => `> ${line}`).join("\n");
  return `Retrying your earlier message; its Codex turn failed because Codex auth was rejected:\n\n${quoted}`;
}

// `orkestr threads retry-failed --since 2h [--dry-run]`: re-sends inputs whose
// Codex turn failed for auth, quoted, once per failed turn (idempotent).
export async function retryFailedThreadsCommand(argv, ctx) {
  const since = flag(argv, "--since") || "2h";
  const dryRun = argv.includes("--dry-run");
  const payload = await requestJson(`/api/system/codex-auth/failed-turns?since=${encodeURIComponent(since)}`, ctx);
  const seen = new Set();
  let failures = 0;
  for (const turn of payload.turns || []) {
    const label = `${turn.threadName || turn.threadId} turn ${turn.turnId || "?"}`;
    if (!turn.text || turn.role !== "user" || seen.has(turn.messageId)) {
      ctx.stdout.write(`skip ${label}: ${turn.text ? "not a user input or duplicate" : "input message not found"}\n`);
      continue;
    }
    seen.add(turn.messageId);
    if (turn.state === "queued") {
      ctx.stdout.write(`skip ${label}: input is still queued and will be delivered after auth repair\n`);
      continue;
    }
    if (dryRun) {
      ctx.stdout.write(`would retry ${label}: ${turn.text.slice(0, 80)}\n`);
      continue;
    }
    try {
      await requestJson(`/api/threads/${encodeURIComponent(turn.threadId)}/input`, {
        ...ctx,
        method: "POST",
        body: { text: retryText(turn), source: "cli", idempotencyKey: `codex-auth-retry:${turn.threadId}:${turn.messageId}` },
      });
      ctx.stdout.write(`retried ${label}\n`);
    } catch (error) {
      failures += 1;
      ctx.stderr.write(`failed ${label}: ${error?.message || String(error)}\n`);
    }
  }
  if (!(payload.turns || []).length) ctx.stdout.write(`No auth-failed turns since ${since}.\n`);
  return failures ? 1 : 0;
}
