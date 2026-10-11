import { ApiError, requestJson } from "./api-client.js";

export const SETUP_USAGE = [
  "Usage: orkestr setup <list|install|status|uninstall> [setup-id] [--provider codex|claude-code] [--timezone Area/City] [--json]",
  "  Preview: installs one thread, its standing instructions and scheduled check-ins. Never connects WhatsApp.",
].join("\n");

function flagValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? String(argv[index + 1] || "") : "";
}

function positional(argv) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index].startsWith("--")) {
      if (argv[index] !== "--json") index += 1;
      continue;
    }
    values.push(argv[index]);
  }
  return values;
}

function formatList(setups) {
  return setups.map((setup) => [
    `${setup.id}  ${setup.title}  (${setup.status}, v${setup.version})`,
    `  ${setup.summary}`,
    `  Needs: ${setup.providers.join(" or ")} login${setup.alwaysOn ? "; host must stay on for check-ins" : ""}`,
    `  Creates: 1 thread, ${setup.timers.length} scheduled check-ins (${setup.timers.map((timer) => `${timer.cadence} ${timer.time}`).join(", ")})`,
  ].join("\n")).join("\n\n") || "No Setups available.";
}

function formatInstance(instance) {
  const health = instance.health || {};
  const timers = (health.timers || instance.resources.timers || []).map((timer) => `${timer.key}${timer.present === false ? " (missing)" : ""}`);
  return [
    `${instance.setupId}  ${instance.status}  ${instance.instanceId}`,
    `  provider: ${instance.provider}${instance.timezone ? `, timezone: ${instance.timezone}` : ""}`,
    `  thread: ${instance.resources.threadId || "-"}${health.thread ? ` (${health.thread})` : ""}`,
    `  check-ins: ${timers.join(", ") || "-"}`,
    `  WhatsApp: ${health.whatsapp || "not_bound"}`,
  ].join("\n");
}

function explainFailure(error) {
  const payload = error instanceof ApiError ? error.payload || {} : {};
  const code = payload.error || error.message;
  if (code === "setup_prerequisite_missing") {
    const checked = (payload.checked || []).map((entry) => `${entry.provider}: ${entry.reason}`).join(", ");
    return `Setup needs a signed-in AI provider first (${checked}). Sign in to Codex or Claude Code in Orkestr, then retry.`;
  }
  if (payload.rollback) return `${code}: install failed and was rolled back (${JSON.stringify(payload.rollback)}).`;
  return code;
}

export async function setupCommand(argv, ctx) {
  const subcommand = argv[0] || "list";
  const rest = argv.slice(1);
  const json = rest.includes("--json") || argv.includes("--json");
  const [setupId = ""] = positional(rest);
  const write = (payload, text) => ctx.stdout.write(`${json ? JSON.stringify(payload, null, 2) : text}\n`);
  try {
    if (subcommand === "list" || subcommand === "--json") {
      const payload = await requestJson("/api/setups", ctx);
      write(payload, formatList(payload.setups || []));
      return 0;
    }
    if (subcommand === "status") {
      const query = setupId ? `?setupId=${encodeURIComponent(setupId)}` : "";
      const payload = await requestJson(`/api/setups/status${query}`, ctx);
      write(payload, (payload.instances || []).map(formatInstance).join("\n\n") || "No Setups installed.");
      return 0;
    }
    if (!setupId) throw new Error(SETUP_USAGE);
    if (subcommand === "install") {
      const payload = await requestJson(`/api/setups/${encodeURIComponent(setupId)}/install`, {
        ...ctx,
        method: "POST",
        body: { provider: flagValue(rest, "--provider"), timezone: flagValue(rest, "--timezone") },
      });
      const lead = payload.outcome === "already_installed" ? "Already installed; nothing changed." : "Installed.";
      write(payload, `${lead}\n${formatInstance(payload.instance)}\nWhatsApp is not connected. Bind a chat yourself if you want to use it there.`);
      return 0;
    }
    if (subcommand === "uninstall") {
      const payload = await requestJson(`/api/setups/${encodeURIComponent(setupId)}`, { ...ctx, method: "DELETE" });
      if (payload.outcome === "not_installed") write(payload, `${setupId} is not installed; nothing changed.`);
      else write(payload, `Uninstalled ${setupId}. Thread ${payload.released.thread}; check-ins: ${payload.released.timers.map((timer) => `${timer.key} ${timer.result}`).join(", ")}.${payload.stateRetained ? `\nRecords kept in ${payload.stateRetained}.` : ""}`);
      return 0;
    }
    throw new Error(SETUP_USAGE);
  } catch (error) {
    if (error.message === SETUP_USAGE) throw error;
    ctx.stderr.write(`${explainFailure(error)}\n`);
    return 1;
  }
}
