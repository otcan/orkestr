import { requestJson } from "./api-client.js";
import { threadName } from "./format.js";

const CREATE_USAGE = "Usage: orkestr create <name> [--prompt text] [--cwd path] [--command command] [--executor id] [--wa-title title] [--wa-participant jid]... [--chat-id jid] [--outbound-account id] [--reply-prefix text] [--no-wa] [--no-wa-admin] [--json]";

export async function createCommand(argv, ctx) {
  const json = argv.includes("--json");
  const name = positional(argv)[0];
  if (!name) throw new Error(CREATE_USAGE);

  const noWhatsApp = argv.includes("--no-wa");
  const outboundAccountId = firstFlagValue(argv, ["--outbound-account", "--responder-account"]);
  const senderAccountId = firstFlagValue(argv, ["--sender-account", "--inbound-account"]);
  const displayName = firstFlagValue(argv, ["--wa-title", "--title"]) || name;
  const replyPrefix = firstFlagValue(argv, ["--reply-prefix"]) || "otcanclaw:";
  const explicitChatId = firstFlagValue(argv, ["--chat-id"]);

  let whatsappGroup = null;
  let chatId = explicitChatId;
  if (!noWhatsApp && !chatId) {
    whatsappGroup = await createWhatsAppGroup({
      argv,
      ctx,
      displayName,
      outboundAccountId,
      senderAccountId,
    });
    chatId = String(whatsappGroup?.chat?.id || "").trim();
    if (!chatId) throw new Error("WhatsApp chat was created but no chat id was returned.");
  }

  const threadPayload = await requestJson("/api/threads", {
    ...ctx,
    method: "POST",
    body: threadCreateBody(argv, name),
  });
  const thread = threadPayload?.thread || threadPayload;
  const threadId = String(thread?.id || "").trim();
  if (!threadId) throw new Error("Orkestr thread create did not return an id.");

  let bindingPayload = null;
  if (!noWhatsApp && chatId) {
    bindingPayload = await requestJson(`/api/threads/${encodeURIComponent(threadId)}/binding`, {
      ...ctx,
      method: "PUT",
      body: bindingBody({
        chatId,
        displayName,
        replyPrefix,
        outboundAccountId,
        senderAccountId,
        whatsappGroup,
        generated: Boolean(whatsappGroup?.chat?.generated && !explicitChatId),
      }),
    });
  }

  if (json) {
    ctx.stdout.write(`${JSON.stringify({ ok: true, thread, whatsappGroup, binding: bindingPayload?.binding || null }, null, 2)}\n`);
  } else {
    ctx.stdout.write(`Created Orkestr thread: ${threadName(thread)}\t${threadId}\n`);
    ctx.stdout.write(`Runtime: ${thread.state || "sleeping"}\n`);
    if (!noWhatsApp) {
      ctx.stdout.write(`WhatsApp chat: ${displayName}\t${chatId || "unbound"}\n`);
      ctx.stdout.write(`Binding: ${bindingPayload?.ok === true ? "true" : "false"}\n`);
    }
  }
  return 0;
}

function createWhatsAppGroup({ argv, ctx, displayName, outboundAccountId, senderAccountId }) {
  const participantIds = repeatedFlagValues(argv, ["--wa-participant", "--participant"]);
  const body = {
    name: displayName,
    participantIds,
    promoteParticipantsAsAdmins: !argv.includes("--no-wa-admin") && !argv.includes("--no-admin"),
  };
  if (outboundAccountId) {
    body.responderAccountId = outboundAccountId;
    body.outboundAccountId = outboundAccountId;
  }
  if (senderAccountId) body.senderAccountId = senderAccountId;
  return requestJson("/api/connectors/whatsapp/bridge/chats", {
    ...ctx,
    method: "POST",
    body,
  });
}

function threadCreateBody(argv, name) {
  const body = { name };
  const fields = [
    ["id", ["--id"]],
    ["prompt", ["--prompt"]],
    ["cwd", ["--cwd", "--project-root"]],
    ["command", ["--command", "--cmd"]],
    ["executorId", ["--executor"]],
  ];
  for (const [key, flags] of fields) {
    const value = firstFlagValue(argv, flags);
    if (value) body[key] = value;
  }
  return body;
}

function bindingBody({ chatId, displayName, replyPrefix, outboundAccountId, senderAccountId, whatsappGroup, generated }) {
  const body = {
    connector: "whatsapp",
    chatId,
    displayName,
    enabled: true,
    allowOtherPeople: true,
    additionalParticipantsEnabled: false,
    mirrorToWhatsApp: true,
    replyPrefix,
    generated,
  };
  if (senderAccountId) body.senderAccountId = senderAccountId;
  if (outboundAccountId) {
    body.responderAccountId = outboundAccountId;
    body.outboundAccountId = outboundAccountId;
  } else if (whatsappGroup?.responderAccountId) {
    body.responderAccountId = whatsappGroup.responderAccountId;
    body.outboundAccountId = whatsappGroup.responderAccountId;
  }
  if (whatsappGroup?.senderContactId) body.senderContactId = whatsappGroup.senderContactId;
  if (whatsappGroup?.responderContactId) body.responderContactId = whatsappGroup.responderContactId;
  return body;
}

function positional(argv) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value.startsWith("--")) {
      if (!booleanFlags.has(value)) index += 1;
      continue;
    }
    values.push(value);
  }
  return values;
}

function firstFlagValue(argv, flags) {
  for (const flag of flags) {
    const index = argv.indexOf(flag);
    if (index >= 0) return argv[index + 1] || "";
  }
  return "";
}

function repeatedFlagValues(argv, flags) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (flags.includes(argv[index])) values.push(argv[index + 1] || "");
  }
  return values.map((value) => String(value || "").trim()).filter(Boolean);
}

const booleanFlags = new Set([
  "--json",
  "--no-admin",
  "--no-wa",
  "--no-wa-admin",
]);
