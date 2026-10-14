import { requestJson } from "./api-client.js";

const usage = "Usage: orkestr whatsapp pictures audit --account <id> [--chat-ids id,...] [--json]";
const valueFlags = new Set(["--account", "--account-id", "--chat-ids", "--chat-id"]);

// Strict parsing: a value flag needs a value that is not another flag, and flag
// values never count as the positional account id. A malformed call must not
// widen the audit to every group.
export function parsePictureAuditArgs(argv = []) {
  const values = {};
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] || "");
    if (valueFlags.has(arg)) {
      const value = String(argv[index + 1] ?? "");
      if (!value || value.startsWith("-")) throw new Error(`${arg} needs a value. ${usage}`);
      values[arg] = value;
      index += 1;
    } else if (!arg.startsWith("-")) {
      positionals.push(arg);
    }
  }
  const accountId = values["--account"] || values["--account-id"] || positionals[0] || "";
  if (!accountId) throw new Error(usage);
  const rawChatIds = values["--chat-ids"] ?? values["--chat-id"];
  const chatIds = rawChatIds === undefined ? [] : rawChatIds.split(",").map((s) => s.trim()).filter(Boolean);
  if (rawChatIds !== undefined && !chatIds.length) throw new Error(`--chat-ids needs at least one chat id. ${usage}`);
  return { accountId, chatIds };
}

export async function whatsappPictureAuditCommand(argv, ctx) {
  const json = argv.includes("--json");
  const { accountId, chatIds } = parsePictureAuditArgs(argv);
  const payload = await requestJson(
    `/api/connectors/whatsapp/bridge/accounts/${encodeURIComponent(accountId)}/chats/picture-audit`,
    { ...ctx, method: "POST", body: chatIds.length ? { chatIds } : { chatIds: [], allGroups: true } },
  );
  if (json) {
    ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    const results = Array.isArray(payload.results) ? payload.results : [];
    ctx.stdout.write(`WhatsApp group picture audit: ${accountId}\n`);
    for (const entry of results) {
      ctx.stdout.write(`${entry.chatId}: ${entry.status}\n`);
    }
    if (!results.length) ctx.stdout.write("No groups audited.\n");
  }
  return payload.ok === false ? 1 : 0;
}
