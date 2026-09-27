import { requestJson } from "./api-client.js";

function positional(argv) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value.startsWith("--")) {
      if (value !== "--json") index += 1;
      continue;
    }
    values.push(value);
  }
  return values;
}

function flagValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] || "" : "";
}

const MISSION_USAGE = "Usage: orkestr thread mission <get|set|clear> <thread> [mission text] [--text text] [--json]";

export async function threadMissionCommand(argv, ctx) {
  const subcommand = argv[0] || "";
  const rest = argv.slice(1);
  const json = rest.includes("--json");
  const values = positional(rest);
  const threadId = values[0];
  if (!threadId) throw new Error(MISSION_USAGE);

  if (subcommand === "get") {
    const payload = await requestJson(`/api/threads/${encodeURIComponent(threadId)}/mission`, ctx);
    if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else ctx.stdout.write(`${payload.standingMission || "(none)"}\n`);
    return 0;
  }
  if (subcommand === "set") {
    const mission = (flagValue(rest, "--text") || values.slice(1).join(" ")).trim();
    if (!mission) throw new Error(MISSION_USAGE);
    const payload = await requestJson(`/api/threads/${encodeURIComponent(threadId)}/mission`, {
      ...ctx,
      method: "PUT",
      body: { mission },
    });
    if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else ctx.stdout.write(`Standing mission set for ${threadId}\n`);
    return 0;
  }
  if (subcommand === "clear") {
    const payload = await requestJson(`/api/threads/${encodeURIComponent(threadId)}/mission`, { ...ctx, method: "DELETE" });
    if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else ctx.stdout.write(`Standing mission cleared for ${threadId}\n`);
    return 0;
  }
  throw new Error(MISSION_USAGE);
}
