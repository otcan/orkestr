#!/usr/bin/env node
// Owner-authorized synthetic WhatsApp health probe for scoped group routing.
//
// A secondary owner account (the "sender" bridge) posts one fixed, labelled
// probe text into ONE dedicated probe group whose only participants are the
// two owner accounts. The primary worker must record it, the relay must route
// it to the group's (probe-only) thread, and the thread's reply must be sent.
// The probe never chooses another chat, never sends free text and never
// touches a real work thread. Exit code 0 = healthy or degraded, 1 = failed.
// Degraded: the reply was not delivered in time while the model provider was
// rate limiting (HTTP 429 retries in the configured Codex logs). The WhatsApp
// path itself worked, so it does not count toward the failure alert.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { isMainModule } from './main-module.mjs';

export const PROBE_LABEL = '[Orkestr health probe] automated WhatsApp check, please reply: pong';
const fail = (code, extra = {}) => { throw Object.assign(new Error(code), { probeCode: code, ...extra }); };
export const RATE_LIMIT_CODE = 'probe_reply_delayed_provider_rate_limit';

// True when any configured Codex log database recorded a provider 429 retry
// between the two instants. Read-only; an unreadable log is "no evidence".
export function providerRateLimited(logPaths, sinceMs, untilMs) {
  for (const file of Array.isArray(logPaths) ? logPaths : []) {
    let db;
    try {
      db = new DatabaseSync(file, { readOnly: true });
      const hit = db.prepare("SELECT 1 FROM logs WHERE ts>=? AND ts<=? AND target LIKE 'codex%' AND feedback_log_body LIKE '%429 Too Many Requests%' LIMIT 1")
        .get(Math.floor(sinceMs / 1000), Math.ceil(untilMs / 1000));
      if (hit) return true;
    } catch { /* missing or locked log: no evidence */ }
    finally { try { db?.close(); } catch { /* ignore */ } }
  }
  return false;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const participantId = p => typeof p?.id === 'string' ? p.id : p?.id?._serialized;

export function probeTarget(probe, primary, sender) {
  const group = (primary.groups || []).find(g => g.chatId === probe.chatId);
  if (!group || group.threadId !== probe.threadId) fail('probe_group_not_bound_to_probe_thread');
  // The probe thread must own exactly this one group: probe input can never reach a work thread.
  if ((primary.groups || []).filter(g => g.threadId === probe.threadId).length !== 1) fail('probe_thread_shared');
  if (!(sender.groups || []).some(g => g.chatId === probe.chatId)) fail('probe_group_not_in_sender_scope');
  if (!/^\d+@c\.us$/.test(primary.ownChatId || '') || !/^\d+@c\.us$/.test(sender.ownChatId || '') || primary.ownChatId === sender.ownChatId)
    fail('probe_owner_accounts_invalid');
  return { chatId: probe.chatId, owners: [primary.ownChatId, sender.ownChatId].sort() };
}

// intakeOnly: pass once the primary recorded the probe and the relay routed it
// into the probe thread. Used inside a deploy, where the UI drain may hold the
// thread's reply until the deploy finishes; the full probe runs afterwards.
export async function runProbe({ probe, primary, sender, token, intakeOnly = false, fetchImpl = fetch, now = Date.now, wait = sleep, nonce = crypto.randomBytes(4).toString('hex') }) {
  const target = probeTarget(probe, primary, sender);
  const base = String(probe.senderUrl || '').replace(/\/$/, '');
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const meta = await (await fetchImpl(`${base}/api/chats/${encodeURIComponent(target.chatId)}/meta`, { headers })).json();
  const members = (meta?.groupMetadata?.participants || []).map(participantId).sort();
  if (JSON.stringify(members) !== JSON.stringify(target.owners)) fail('probe_group_has_other_participants');
  const senderDb = new DatabaseSync(sender.journalPath, { readOnly: true });
  let parent;
  try { parent = senderDb.prepare('SELECT id FROM group_input WHERE chat_id=? ORDER BY created_at DESC LIMIT 1').get(target.chatId)?.id; }
  finally { senderDb.close(); }
  if (!parent) fail('probe_parent_missing');
  const text = `${PROBE_LABEL} #${nonce}`;
  const started = now();
  const response = await fetchImpl(`${base}/send-text`, { method: 'POST', headers,
    body: JSON.stringify({ to: target.chatId, accountId: 'main', requestId: `probe:${nonce}`, parentId: parent, text }) });
  const sent = await response.json().catch(() => ({}));
  if (!response.ok || sent.ok !== true) fail('probe_send_failed');
  const deadline = started + Number(probe.timeoutMs || 300000);
  let inputId = null;
  while (now() < deadline) {
    const db = new DatabaseSync(primary.journalPath, { readOnly: true });
    try {
      inputId ||= db.prepare('SELECT id FROM group_input WHERE chat_id=? AND body=?').get(target.chatId, text)?.id || null;
      if (inputId && !intakeOnly && db.prepare("SELECT 1 FROM group_send WHERE parent_id=? AND chat_id=? AND state='sent' AND provider_id IS NOT NULL").get(inputId, target.chatId))
        return { ok: true, nonce, totalMs: now() - started };
    } finally { db.close(); }
    if (inputId && intakeOnly) {
      const relay = new DatabaseSync(primary.relayJournalPath, { readOnly: true });
      try {
        if (relay.prepare('SELECT 1 FROM routed WHERE id=? AND thread_id=?').get(inputId, probe.threadId))
          return { ok: true, nonce, intakeOnly: true, totalMs: now() - started };
      } finally { relay.close(); }
    }
    await wait(Number(probe.pollMs || 5000));
  }
  if (inputId && !intakeOnly && providerRateLimited(probe.providerRateLimitLogs, started - Number(probe.rateLimitLookbackMs ?? 600000), now()))
    fail(RATE_LIMIT_CODE, { degraded: true });
  fail(!inputId ? 'probe_input_not_recorded' : intakeOnly ? 'probe_input_not_routed' : 'probe_reply_not_delivered');
}

// Alert after N consecutive failures, once per failure streak. A degraded run
// (provider rate limit) neither counts as a failure nor resets the streak; a
// long degraded streak alerts once on its own after `degradedAlertAfter` runs.
export function recordOutcome(statePath, outcome, { alertAfter = 2, degradedAlertAfter = 8, alert = () => {}, now = Date.now } = {}) {
  let state = {};
  try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { state = {}; }
  const at = new Date(now()).toISOString();
  if (outcome.ok) state = { consecutiveFailures: 0, lastOkAt: at, lastCheckAt: at, alerted: false };
  else if (outcome.degraded) {
    state = { ...state, consecutiveFailures: Number(state.consecutiveFailures || 0), consecutiveDegraded: Number(state.consecutiveDegraded || 0) + 1,
      lastDegraded: outcome.code, lastDegradedAt: at, lastCheckAt: at };
    if (state.consecutiveDegraded >= degradedAlertAfter && !state.degradedAlerted) {
      alert({ ...state, lastError: outcome.code, degraded: true }); state.degradedAlerted = true; state.lastAlertAt = at;
    }
  } else {
    state = { ...state, consecutiveFailures: Number(state.consecutiveFailures || 0) + 1, consecutiveDegraded: 0, degradedAlerted: false, lastError: outcome.code, lastCheckAt: at };
    if (state.consecutiveFailures >= alertAfter && !state.alerted) { alert(state); state.alerted = true; state.lastAlertAt = at; }
  }
  fs.writeFileSync(`${statePath}.tmp`, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(`${statePath}.tmp`, statePath);
  return state;
}

if (isMainModule(import.meta.url)) {
  const probe = readJson(process.argv[2]);
  let outcome;
  try {
    const result = await runProbe({ probe, intakeOnly: process.argv.includes('--intake-only'), primary: readJson(probe.primaryConfigPath), sender: readJson(probe.senderConfigPath),
      token: fs.readFileSync(probe.senderTokenFile, 'utf8').trim() });
    outcome = { ok: true, ...result };
  } catch (error) {
    outcome = { ok: false, code: error.probeCode || 'probe_operation_failed', ...(error.degraded ? { degraded: true } : {}) };
  }
  const state = recordOutcome(probe.statePath, outcome, { alertAfter: Number(probe.alertAfter || 2), degradedAlertAfter: Number(probe.degradedAlertAfter || 8), alert: s => {
    if (!Array.isArray(probe.alertCommand) || !probe.alertCommand.length) return;
    const body = s.degraded
      ? `Orkestr WhatsApp health probe replies delayed by model provider rate limits ${s.consecutiveDegraded} times in a row.\nLast success: ${s.lastOkAt || 'never'}\n`
      : `Orkestr WhatsApp health probe failed ${s.consecutiveFailures} times in a row.\nLast error: ${s.lastError}\nLast success: ${s.lastOkAt || 'never'}\n`;
    spawnSync(probe.alertCommand[0], probe.alertCommand.slice(1), { input: body, timeout: 60000,
      env: { ...process.env, PROBE_ALERT_SUBJECT: s.degraded ? 'Orkestr WhatsApp probe degraded (provider rate limit)' : `Orkestr WhatsApp probe failing (${s.lastError})` } });
  } });
  console.log(JSON.stringify({ event: 'whatsapp_group_probe', ...outcome, consecutiveFailures: state.consecutiveFailures, consecutiveDegraded: state.consecutiveDegraded || 0 }));
  process.exitCode = outcome.ok || outcome.degraded ? 0 : 1;
}
