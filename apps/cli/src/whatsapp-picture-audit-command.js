import { requestJson } from "./api-client.js";

function positional(argv) {
  return argv.filter((v) => !v.startsWith("-"));
}

function flagValue(argv, flag) {
  const index = argv.indexOf(flag);
  if (index === -1 || index + 1 >= argv.length) return "";
  return String(argv[index + 1] || "");
}

export async function whatsappPictureAuditCommand(argv, ctx) {
  const json = argv.includes("--json");
  const accountId =
    flagValue(argv, "--account") ||
    flagValue(argv, "--account-id") ||
    positional(argv)[0] ||
    "";
  if (!accountId) {
    throw new Error("Usage: orkestr whatsapp pictures audit --account <id> [--chat-ids id,...] [--json]");
  }
  const rawChatIds = flagValue(argv, "--chat-ids") || flagValue(argv, "--chat-id") || "";
  const chatIds = rawChatIds ? rawChatIds.split(",").map((s) => s.trim()).filter(Boolean) : [];
  const payload = await requestJson(
    `/api/connectors/whatsapp/bridge/accounts/${encodeURIComponent(accountId)}/chats/picture-audit`,
    { ...ctx, method: "POST", body: { chatIds } },
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
