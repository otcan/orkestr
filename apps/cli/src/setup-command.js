import { ApiError, requestJson } from "./api-client.js";

export const SETUP_USAGE = [
  "Usage: orkestr setup list|status [--json]",
  "       orkestr setup install <setup-id> [--provider codex|claude-code] [--timezone Area/City] [--opt-in <check-in>[,...]] [--json]",
  "       orkestr setup configure <setup-id> [--enable <check-in>[,...]] [--disable <check-in>[,...]] [--json]",
  "       orkestr setup pause|resume|export|uninstall <setup-id> [--json]",
  "  Preview: installs one thread, its standing instructions and scheduled check-ins (off until you opt in). Never connects WhatsApp.",
].join("\n");

function flagValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? String(argv[index + 1] || "") : "";
}

function keys(argv, flag) {
  const values = [];
  argv.forEach((value, index) => { if (value === flag) values.push(...String(argv[index + 1] || "").split(",")); });
  return values.map((value) => value.trim()).filter(Boolean);
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
    `  Creates: 1 thread, ${setup.timers.length} scheduled check-ins, off until you opt in (${setup.timers.map((timer) => `${timer.key}: ${timer.cadence} ${timer.time}`).join(", ")})`,
  ].join("\n")).join("\n\n") || "No Setups available.";
}

function formatInstance(instance) {
  const health = instance.health || {};
  const timers = (health.timers || instance.resources.timers || []).map((timer) => `${timer.key}${timer.present === false ? " (missing)" : timer.enabled === undefined ? "" : timer.enabled ? " (on)" : " (off)"}`);
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
        body: { provider: flagValue(rest, "--provider"), timezone: flagValue(rest, "--timezone"), optIn: keys(rest, "--opt-in") },
      });
      const lead = payload.outcome === "already_installed" ? "Already installed; nothing changed." : "Installed.";
      write(payload, `${lead}\n${formatInstance(payload.instance)}\nCheck-ins: ${(payload.checkIns || []).map((checkIn) => `${checkIn.key} ${checkIn.enabled ? "on" : "off"}`).join(", ")}. Turn one on with: orkestr setup configure ${setupId} --enable <check-in>\nWhatsApp is not connected. Bind a chat yourself if you want to use it there.`);
      return 0;
    }
    if (["configure", "pause", "resume"].includes(subcommand)) {
      const body = subcommand === "configure" ? { enable: keys(rest, "--enable"), disable: keys(rest, "--disable") } : {};
      const payload = await requestJson(`/api/setups/${encodeURIComponent(setupId)}/${subcommand}`, { ...ctx, method: "POST", body });
      write(payload, `${setupId}: ${payload.changes.map((change) => `${change.key} ${change.result}`).join(", ") || "nothing to change"}.`);
      return 0;
    }
    if (subcommand === "export") {
      const payload = await requestJson(`/api/setups/${encodeURIComponent(setupId)}/export`, ctx);
      ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
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
