import assert from "node:assert/strict";
import test from "node:test";
import { formatWhatsAppHelp, whatsappHelpCommand } from "../packages/connectors/src/whatsapp-help.js";
import { providerQuotaLine, quotaResetCountdown } from "../packages/connectors/src/whatsapp-quota-footer.js";

const now = Date.parse("2099-01-10T12:00:00Z");
const minute = 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

test("whatsappHelpCommand matches /help only as a whole command", () => {
  assert.equal(whatsappHelpCommand("/help"), true);
  assert.equal(whatsappHelpCommand("  /HELP  "), true);
  assert.equal(whatsappHelpCommand("/help model"), true);
  assert.equal(whatsappHelpCommand("/helper"), false);
  assert.equal(whatsappHelpCommand("help"), false);
  assert.equal(whatsappHelpCommand("please /help"), false);
  assert.equal(whatsappHelpCommand(""), false);
});

test("Codex help lists the Claude switch, fast, plan/code with the current mode and runtime switch", () => {
  const codexThread = { id: "thread-help", runtimeKind: "codex-app-server", codexThreadId: "fake-generation" };
  const code = formatWhatsAppHelp({ thread: codexThread, statusText: "Thread: Demo\nStatus: ready", env: {} });
  assert.match(code, /^\*Orkestr help\*\n\nThread: Demo\nStatus: ready\n/);
  assert.match(code, /^\/claude – switch this thread to Claude Code \(now: Codex\)$/m);
  assert.doesNotMatch(code, /^\/codex /m);
  assert.match(code, /^\/model /m);
  assert.match(code, /^\/effort /m);
  assert.match(code, /^\/fast /m);
  assert.match(code, /^\/plan \[message\] or \/code \[message\] – .*\(now: code\)$/m);
  assert.match(code, /^\/rt api \| \/rt terminal /m);
  assert.match(code, /^\/status /m);

  const plan = formatWhatsAppHelp({ thread: { ...codexThread, codexModeLive: "plan" }, env: {} });
  assert.match(plan, /\(now: plan\)$/m);

  // Settings commands the thread cannot apply are not advertised.
  const disabled = formatWhatsAppHelp({ thread: codexThread, env: { ORKESTR_SETTINGS_COMMANDS_ENABLED: "0" } });
  assert.doesNotMatch(disabled, /^\/(?:model|effort|fast) /m);
  assert.match(disabled, /^\/claude /m);
  const readOnly = formatWhatsAppHelp({ thread: { id: "terminal", runtimeKind: "codex-tmux" }, env: {} });
  assert.doesNotMatch(readOnly, /^\/(?:model|effort|fast) /m);
  assert.match(readOnly, /^\/rt api /m);
});

test("Claude help lists the Codex switch without Codex-only controls", () => {
  const help = formatWhatsAppHelp({
    thread: { runtimeKind: "claude-code", executor: { type: "claude-code", metadata: {} } },
    statusText: "Status: working",
    env: {},
  });
  assert.match(help, /\nStatus: working\n/);
  assert.match(help, /^\/codex – switch this thread to Codex \(now: Claude Code\)$/m);
  assert.doesNotMatch(help, /^\/claude /m);
  assert.doesNotMatch(help, /^\/fast /m);
  assert.doesNotMatch(help, /^\/plan /m);
  assert.doesNotMatch(help, /^\/rt /m);
  assert.match(help, /^\/model /m);
  assert.match(help, /^\/effort /m);

  const disabled = formatWhatsAppHelp({
    thread: { runtimeKind: "claude-code", executor: { type: "claude-code", metadata: {} } },
    env: { ORKESTR_SETTINGS_COMMANDS_ENABLED: "0" },
  });
  assert.doesNotMatch(disabled, /^\/(?:model|effort) /m);
});

test("help omits the status block when no status text is given", () => {
  const help = formatWhatsAppHelp({ thread: { runtimeKind: "codex-app-server" }, env: {} });
  assert.match(help, /^\*Orkestr help\*\n\n\*Messages\*\n/);
});

test("quotaResetCountdown formats days, hours and minutes until reset", () => {
  assert.equal(quotaResetCountdown(iso(now + (2 * 24 + 23) * 60 * minute), now), "2d23h");
  assert.equal(quotaResetCountdown(iso(now + 90 * minute), now), "1h30");
  assert.equal(quotaResetCountdown(iso(now + 65 * minute), now), "1h05");
  assert.equal(quotaResetCountdown(iso(now + 45 * minute), now), "45m");
  assert.equal(quotaResetCountdown(iso(now - 5 * minute), now), "0m");
  assert.equal(quotaResetCountdown("", now), "");
  assert.equal(quotaResetCountdown("not-a-date", now), "");
  assert.equal(quotaResetCountdown(undefined, now), "");
});

test("providerQuotaLine shows reported windows with countdowns and omits missing ones", () => {
  assert.equal(providerQuotaLine({
    fiveHourRemainingPct: 90,
    fiveHourResetsAt: iso(now + 90 * minute),
    weeklyRemainingPct: 99,
    weeklyResetsAt: iso(now + (24 + 23) * 60 * minute),
  }, "claude", now), "claude 5h: 90% (1h30) wk: 99% (1d23h)");
  assert.equal(providerQuotaLine({
    fiveHourRemainingPct: null,
    weeklyRemainingPct: 71,
    weeklyResetsAt: iso(now + (2 * 24 + 23) * 60 * minute),
  }, "codex", now), "codex wk: 71% (2d23h)");
  assert.equal(providerQuotaLine({ weeklyRemainingPct: 40, limited: true, stale: true }, "codex", now), "codex wk: 40% (limited) (stale)");
  assert.equal(providerQuotaLine(null, "codex", now), "codex: no data");
  assert.equal(providerQuotaLine({ limited: true }, "claude", now), "claude: no data (limited)");
});
