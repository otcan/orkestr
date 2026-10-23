// Explicit per-group consent; this sender observes actual transport attempts.
// The durable request ID and frozen text survive a retry or process restart.
export function createScopedAcknowledgements({config, inbox, db, groups, now, key, serial, blocked, inspect, send, log}) {
  db.exec(`CREATE TABLE IF NOT EXISTS scoped_real_reply_activity(input_id TEXT PRIMARY KEY,reason TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS scoped_acknowledgements(input_id TEXT PRIMARY KEY,request_id TEXT NOT NULL,text TEXT NOT NULL,state TEXT NOT NULL,sent_at TEXT);`);
  const policy = config.acknowledgement;
  if (policy !== undefined && (!policy || typeof policy.text !== 'string' || !policy.text.trim() || policy.text.length > 500 || !Number.isFinite(Date.parse(policy.since))))
    throw new Error('group_acknowledgement_configuration_invalid');
  const timers = new Map();
  let closed = false;
  const covered = id => Boolean(db.prepare('SELECT 1 FROM scoped_real_reply_activity WHERE input_id=?').get(id));
  const mark = (id, reason) => db.prepare('INSERT OR IGNORE INTO scoped_real_reply_activity VALUES(?,?)').run(id, reason);
  function eligible(input) {
    const group = groups.get(input.chat_id), at = Date.parse(input.created_at);
    if (!policy || group?.deterministicAcknowledgement !== true || !Number.isFinite(at) || at < Date.parse(policy.since) ||
        now() - at > 300000 || covered(input.id) || db.prepare("SELECT 1 FROM scoped_acknowledgements WHERE input_id=? AND state='sent'").get(input.id)) return false;
    // The transport journal proves these are interactive owner inputs. Timers
    // have no group_input row. Participant-author rows never receive this ack.
    const authors = inbox.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='group_input_author'").get();
    return !authors || !inbox.prepare('SELECT 1 FROM group_input_author WHERE id=?').get(input.id);
  }
  async function due(input) {
    if (closed || now() < Date.parse(input.created_at) + 5000 || !eligible(input) || blocked()) return;
    const group = groups.get(input.chat_id);
    // Fresh binding/history guards run without holding the transport queue.
    // A real send that wins this race records activity before any provider call.
    if (!await inspect(input, group)) return;
    await serial('send', async () => {
      if (closed || !eligible(input) || blocked()) return;
      db.prepare("INSERT OR IGNORE INTO scoped_acknowledgements VALUES(?,?,?,'prepared',NULL)")
        .run(input.id, `reply:${key(`${input.id}:acknowledgement:v1`)}`, policy.text);
      const row = db.prepare('SELECT * FROM scoped_acknowledgements WHERE input_id=?').get(input.id);
      const result = await send({chatId: input.chat_id, requestId: row.request_id, parentId: input.id, text: row.text});
      if (result?.ok !== true || !result.ids?.length) throw new Error('group_acknowledgement_unconfirmed');
      const at = new Date(now()).toISOString();
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare("INSERT OR REPLACE INTO replies VALUES(?,'sent')").run(row.request_id);
        db.prepare('INSERT OR REPLACE INTO reply_receipts VALUES(?,?)').run(row.request_id, JSON.stringify(result.ids.map(String)));
        for (const id of result.ids.map(String)) db.prepare('INSERT OR IGNORE INTO reply_sent_text VALUES(?,?,?,?)').run(id, row.request_id, row.text, at);
        db.prepare("UPDATE scoped_acknowledgements SET state='sent',sent_at=? WHERE input_id=?").run(at, input.id);
        db.exec('COMMIT');
      } catch (error) {db.exec('ROLLBACK'); throw error;}
      log({event: 'group_acknowledgement_sent', threadId: group.threadId, inputId: input.id, sentAt: at});
    });
  }
  return {
    // An attempted real send is conservatively covered too: uncertainty must
    // never cause an additional acknowledgement. This is not a delivery receipt.
    mark,
    async check(input) {await due(input);},
    schedule(inputs) {
      if (!policy || closed) return;
      for (const input of inputs) {
        if (!eligible(input) || timers.has(input.id)) continue;
        const timer = setTimeout(() => {
          due(input).catch(() => log({event: 'group_acknowledgement_pending'})).finally(() => timers.delete(input.id));
        }, Math.max(0, Date.parse(input.created_at) + 5000 - now()));
        timers.set(input.id, timer);
      }
    },
    close() {closed = true; for (const timer of timers.values()) clearTimeout(timer); timers.clear();},
  };
}
