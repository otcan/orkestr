// A pacing check for literal shell sleeps, not a shell security boundary.
// Ignore quoted data and heredocs rather than mistaking scripts/test fixtures
// being written to disk for commands that are about to execute.
export function literalShellSleepSeconds(command = "") {
  const source = String(command);
  const segments = [];
  let segment = "", quote = "";
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    if (quote) {
      if (c === "\\" && quote !== "'") i += 1;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === "\\") { segment += "?"; i += 1; continue; }
    if (c === "'" || c === '"' || c === "`") { quote = c; segment += "?"; continue; }
    if (c === "<" && source[i + 1] === "<") return [];
    if (c === "#" && (!segment || /\s$/.test(segment))) {
      while (i < source.length && source[i] !== "\n") i += 1;
      segments.push(segment); segment = ""; continue;
    }
    if (";|&()\n".includes(c)) { segments.push(segment); segment = ""; }
    else segment += c;
  }
  if (quote) return [];
  segments.push(segment);
  return segments.flatMap((part) => {
    const match = part.match(/^\s*(?:(?:then|do|command|exec)\s+)*(?:\/usr\/bin\/|\/bin\/)?sleep\s+(.*)$/);
    if (!match) return [];
    const args = match[1].trim().replace(/^--\s+/, "").split(/\s+/);
    let seconds = 0;
    for (const arg of args) {
      const duration = arg.match(/^(\d+(?:\.\d*)?|\.\d+)([smhd]?)$/);
      if (!duration) return [];
      seconds += Number(duration[1]) * ({ s: 1, m: 60, h: 3600, d: 86400 }[duration[2]] || 1);
    }
    return [seconds];
  });
}

export function pollingSleepLimit(env = process.env) {
  const raw = env.ORKESTR_CLAUDE_MAX_POLL_SLEEP_SECONDS;
  if (raw === undefined || String(raw).trim() === "") return 30;
  const limit = Number(raw);
  return Number.isFinite(limit) && limit >= 0 ? limit : 30;
}

export function claudePollingDecision(event = {}, limit = 30) {
  if (event.tool_name !== "Bash" || limit === 0) return null;
  if (!literalShellSleepSeconds(event.tool_input?.command).some((seconds) => seconds > limit)) return null;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `This command contains a fixed sleep longer than ${limit} seconds. Check the job or CI status now. Prefer a condition-based watcher that returns on completion, or use waits of at most ${limit} seconds between checks. Keep ownership of the authorized task. Builds and tests may still run for their necessary duration.`,
    },
  };
}
