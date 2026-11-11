// Relay side of reply files: see whatsapp-scoped-reply-files.js for the worker side.
// Files the assistant attached to a reply, after its text (`replyMediaRoot`).
// V1 resolves each to its plaintext snapshot; the worker re-checks the bytes.
// A file V1 cannot resolve is skipped; a failing send is retried on later
// polls and skipped after three attempts so it cannot block the group. A
// skipped file is named once in the chat, plainly (ORK-787):
// "Not sent on WhatsApp: <name> (<reason>). It is in the Orkestr app."
export const notSentLine = (name, reason) => `Not sent on WhatsApp: ${name} (${reason}). It is in the Orkestr app.`;
const displayName = attachment => String(attachment?.filename || attachment?.name ||
  attachment?.deliverySource?.filename || 'file').replace(/[\r\n]+/g, ' ').slice(0, 180);
export function createRelayReplyFiles({config, db, api, send, log, key}) {
async function deliver(input, group, answer, touchThread) {
  const attachments = Array.isArray(answer.attachments) ? answer.attachments : [];
  if (!config.replyMediaRoot || !attachments.length) return;
  let files = null;
  for (const attachment of attachments) {
    const fileKey = String(attachment?.id || '');
    if (!fileKey) continue;
    const requestId = `reply:${key(`${input.id}:${answer.id}:file:${fileKey}`)}`;
    if (db.prepare("SELECT 1 FROM replies WHERE id=? AND state IN ('sent','skipped')").get(requestId)) continue;
    files ||= (await api(`/api/threads/${encodeURIComponent(group.threadId)}/messages/${encodeURIComponent(answer.id)}/scoped-relay-files`)).files || [];
    const file = files.find(candidate => candidate?.id === fileKey);
    const skip = async (reason, said) => {
      db.prepare("INSERT OR REPLACE INTO replies VALUES(?,'skipped')").run(requestId);
      log({event: 'reply_file_skipped', threadId: group.threadId, messageId: answer.id, attachmentId: fileKey, reason});
      // One plain line per skipped file; its own request ID keeps retries single.
      const noticeId = `reply:${key(`${input.id}:${answer.id}:file:${fileKey}:not-sent`)}`;
      if (db.prepare("SELECT 1 FROM replies WHERE id=? AND state='sent'").get(noticeId)) return;
      try {
        const sent = await send({chatId: input.chat_id, requestId: noticeId, parentId: input.id,
          text: notSentLine(displayName(attachment), said)});
        if (sent?.ok === true && sent.ids?.length) db.prepare("INSERT OR REPLACE INTO replies VALUES(?,'sent')").run(noticeId);
      } catch (error) {
        log({event: 'reply_file_notice_failed', threadId: group.threadId, messageId: answer.id, attachmentId: fileKey});
      }
    };
    if (!file) { await skip('no_snapshot', 'unavailable'); continue; }
    await touchThread();
    let result;
    try {
      result = await send({chatId: input.chat_id, requestId, parentId: input.id,
        file: {path: file.path, filename: file.filename, mimetype: file.mimetype, sha256: file.sha256}});
      if (result?.ok !== true || !result.ids?.length) throw new Error('group_reply_unconfirmed');
    } catch (error) {
      db.prepare('INSERT INTO reply_file_attempts(id,attempts) VALUES(?,1) ON CONFLICT(id) DO UPDATE SET attempts=attempts+1').run(requestId);
      if (db.prepare('SELECT attempts FROM reply_file_attempts WHERE id=?').get(requestId).attempts >= 3) { await skip('send_failed', 'could not be sent'); continue; }
      throw error;
    }
    db.prepare("INSERT OR REPLACE INTO replies VALUES(?,'sent')").run(requestId);
    db.prepare('INSERT OR REPLACE INTO reply_receipts VALUES(?,?)').run(requestId, JSON.stringify(result.ids.map(String)));
    log({event: 'reply_file_delivered', threadId: group.threadId, messageId: answer.id, attachmentId: fileKey});
  }
}

  return {deliver};
}
