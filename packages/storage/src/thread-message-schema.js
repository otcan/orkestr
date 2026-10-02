export function ensureThreadMessageSchema(db) {
  db.exec(`
    create table if not exists orkestr_thread_messages (
      thread_id text not null,
      id text not null,
      position integer not null,
      cursor integer not null,
      role text,
      state text,
      source text,
      phase text,
      connector text,
      chat_id text,
      parent_message_id text,
      event_id text,
      codex_thread_id text,
      codex_turn_id text,
      codex_item_id text,
      client_message_id text,
      external_id text,
      created_at text,
      updated_at text,
      data text not null,
      primary key(thread_id, id),
      unique(thread_id, position)
    );
    create index if not exists idx_orkestr_thread_messages_cursor
      on orkestr_thread_messages(thread_id, cursor, position);
    create index if not exists idx_orkestr_thread_messages_state
      on orkestr_thread_messages(thread_id, state, position);
    create index if not exists idx_orkestr_thread_messages_phase
      on orkestr_thread_messages(thread_id, phase, position);
    create index if not exists idx_orkestr_thread_messages_recent_delivery
      on orkestr_thread_messages(thread_id, source, connector, role, state, created_at, position);
    create index if not exists idx_orkestr_thread_messages_client
      on orkestr_thread_messages(thread_id, client_message_id);
    create index if not exists idx_orkestr_thread_messages_external
      on orkestr_thread_messages(thread_id, external_id, chat_id);
    create index if not exists idx_orkestr_thread_messages_parent
      on orkestr_thread_messages(thread_id, parent_message_id, position);
    create index if not exists idx_orkestr_thread_messages_event
      on orkestr_thread_messages(thread_id, event_id);
    create index if not exists idx_orkestr_thread_messages_codex_item
      on orkestr_thread_messages(thread_id, codex_thread_id, codex_turn_id, codex_item_id, role, phase);
    create table if not exists orkestr_thread_message_meta (
      thread_id text primary key,
      source_signature text not null default '',
      revision integer not null default 0,
      migrated_at text,
      updated_at text not null
    );
  `);
}

