// Reversible edits to the pinned whatsapp-web.js injected utility source.
// WhatsApp Web renamed some serialized IDs to $1 (wwebjs issue #201845).
// Keep native identities intact and expose the field expected by wwebjs models.
const initialization = "    window.WWebJS = {};";
const helpers = `${initialization}

    const orkestrSerializedId = value => typeof value === 'string' ? value
        : value?._serialized || value?.$1
            || (value?.user && value?.server ? value.user + '@' + value.server : '');
    const orkestrIdModel = value => {
        const serialized = orkestrSerializedId(value);
        return value && typeof value === 'object' && serialized
            ? { ...value, _serialized: serialized } : value;
    };`;

const lastMessageStart = "            const lastMessage = chat.lastReceivedKey\n";
const chatLookup = "                window.require('WAWebCollections').Chat.get(chatWid) ||";
const alternateLookup = `${chatLookup}
                (() => {
                    // Only use WhatsApp's own cached PN/LID mapping, never infer an alias.
                    try {
                        const alternate = window.require('WAWebApiContact').getAlternateUserWid(chatWid);
                        return alternate && window.require('WAWebCollections').Chat.get(alternate);
                    } catch { return undefined; }
                })() ||`;
const chatModel = "        const model = chat.serialize();";
const normalizedChatModel = `${chatModel}
        let canonicalId = model.id || chat.id;
        if (chat.id?.server === 'lid') {
            try {
                const phone = window.require('WAWebApiContact').getPhoneNumber(chat.id);
                if (phone?.server === 'c.us') canonicalId = phone;
            } catch { /* An unknown alias must retain its native ID. */ }
        }
        model.id = orkestrIdModel(canonicalId);`;

const edits = [
  [initialization, helpers],
  ["        const msg = message.serialize();", `        const msg = message.serialize();
        msg.id = orkestrIdModel(msg.id);
        for (const field of ['from', 'to', 'author']) {
            if (msg[field]) msg[field] = orkestrIdModel(msg[field]);
        }`],
  ["remote: msg.id.remote._serialized,", "remote: orkestrSerializedId(msg.id.remote),"],
  [chatLookup, alternateLookup],
  [chatModel, normalizedChatModel],
  [".createWid(chat.id._serialized);", ".createWid(orkestrSerializedId(chat.id));"],
  ["                p.id = toPn(p.id) ?? p.id;", "                p.id = orkestrIdModel(toPn(p.id) ?? p.id);"],
  [lastMessageStart, "            const lastMessageId = orkestrSerializedId(chat.lastReceivedKey);\n            const lastMessage = lastMessageId\n"],
  [".Msg.get(chat.lastReceivedKey._serialized)", ".Msg.get(lastMessageId)"],
  ["                              chat.lastReceivedKey._serialized,", "                              lastMessageId,"],
  ["        res.isBusiness =", "        res.id = orkestrIdModel(res.id);\n\n        res.isBusiness ="],
];

export function stripWhatsAppHistoryIdPatch(source) {
  for (const [before, after] of [...edits].reverse()) source = source.replace(after, before);
  return source;
}

export function applyWhatsAppHistoryIdPatch(source) {
  for (const [before, after] of edits) {
    if (source.split(before).length !== 2) throw Error("whatsapp_history_id_patch_anchor_mismatch");
    source = source.replace(before, after);
  }
  return source;
}
