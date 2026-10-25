// Media evidence comes from the additive group_input_media side table; journals
// written by the short-lived column migration keep working through COALESCE.
export function readGroupInputs(inbox) {
  const tables = new Set(inbox.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
  const columns = new Set(inbox.prepare('PRAGMA table_info(group_input)').all().map(column => column.name));
  const legacy = name => columns.has(`media_${name}`) ? `i.media_${name}` : 'NULL';
  const side = name => tables.has('group_input_media') ? `m.${name}` : 'NULL';
  const join = tables.has('group_input_media') ? 'LEFT JOIN group_input_media m ON m.id=i.id' : '';
  const field = name => `COALESCE(${side(name)},${legacy(name)}) AS media_${name}`;
  const hasQuote = tables.has('group_input_quote');
  const quoteColumns = hasQuote
    ? ',q.id AS quote_row,q.quoted_id AS quote_id,q.author AS quote_author,q.sent_at AS quote_sent_at,q.body AS quote_body,q.from_me AS quote_from_me,q.resolved AS quote_resolved'
    : '';
  const quoteJoin = hasQuote ? 'LEFT JOIN group_input_quote q ON q.id=i.id' : '';
  return inbox.prepare(`SELECT i.id,i.chat_id,i.body,i.created_at,${['path','filename','mimetype','size'].map(field).join(',')}${quoteColumns}
    FROM group_input i ${join} ${quoteJoin} ORDER BY i.created_at`).all();
}
