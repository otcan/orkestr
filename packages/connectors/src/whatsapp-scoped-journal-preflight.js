// Existing journal contract only. Never create/migrate a database or clear it.
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {scopedGroupContract} from './whatsapp-scoped-group-transport.js';

export function validateScopedGroupJournal(config) {
  if (!config.journalPath || config.journalPath === ':memory:') return;
  let info;
  try { info = fs.statSync(config.journalPath); }
  catch (error) { if (error.code === 'ENOENT') return; throw new Error('group_transport_journal_unreadable'); }
  if (!info.isFile()) throw new Error('group_transport_journal_unreadable');
  let db;
  try {
    db = new DatabaseSync(config.journalPath, {readOnly:true});
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='group_meta'").get()) return;
    const prior = db.prepare("SELECT value FROM group_meta WHERE key='contract'").get();
    if (prior && prior.value !== scopedGroupContract(config)) throw new Error('group_transport_configuration_changed');
  } catch (error) {
    if (error.message === 'group_transport_configuration_changed') throw error;
    throw new Error('group_transport_journal_unreadable');
  } finally { db?.close(); }
}
