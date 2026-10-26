import {readGroupInputs} from './scoped-group-inbox.js';

// Route only new text inputs through the existing authenticated path. Reply
// scans and sends retain their separate serial journal and delivery barriers.
export function createScopedInputAdmission({inbox, db, groups, heldInputIds, routeInput, blocked, errors, errorCode, log}) {
  return async ({stopping = () => false} = {}) => {
    if (blocked() || stopping()) return {admitted: 0, more: false};
    const chats = new Map(), heldChats = new Set();
    let selected = 0, more = false;
    for (const input of readGroupInputs(inbox)) {
      if (heldInputIds.has(input.id) || !groups.has(input.chat_id) || db.prepare('SELECT 1 FROM routed WHERE id=?').get(input.id)) continue;
      if (heldChats.has(input.chat_id)) continue;
      // Media keeps its normal preparation/retry path and order in this chat.
      if (input.media_path) { heldChats.add(input.chat_id); continue; }
      if (chats.has(input.chat_id)) { more = true; continue; }
      if (selected >= 8) { more = true; break; }
      if (!chats.has(input.chat_id)) chats.set(input.chat_id, []);
      chats.get(input.chat_id).push(input);
      selected++;
    }
    let admitted = 0;
    // Different chats can perform owner HTTP checks independently. Sources in
    // the same chat remain FIFO, including an unknown admission response.
    await Promise.allSettled([...chats.values()].map(async inputs => {
      for (const input of inputs) {
        if (blocked() || stopping()) break;
        try {
          await routeInput(input, groups.get(input.chat_id), true);
          if (!db.prepare('SELECT 1 FROM routed WHERE id=?').get(input.id)) break;
          errors.delete(input.id);
          admitted++;
        } catch (error) {
          const code = errorCode(error);
          if (errors.get(input.id) !== code) log({event: 'group_relay_error', threadId: groups.get(input.chat_id)?.threadId, code});
          errors.set(input.id, code);
          break;
        }
      }
    }));
    return {admitted, more: more && admitted > 0};
  };
}

// Coalesce local WAL notifications without waiting for the three-second reply
// poll. A wake arriving during I/O is retained; the fallback poll stays active.
export function createInputJournalWake({admit, log = () => {}, delayMs = 25}) {
  let pending = false, running = false, closed = false, timer, active = Promise.resolve();
  const signal = () => {
    if (closed) return;
    pending = true;
    if (!running && !timer) timer = setTimeout(() => {active = drain();}, delayMs);
  };
  const drain = async () => {
    timer = undefined;
    if (closed || running) return;
    pending = false;
    running = true;
    try { if ((await admit({stopping: () => closed}))?.more) pending = true; }
    catch { log({event: 'group_input_wake_error', code: 'admission_unavailable'}); }
    finally { running = false; if (pending) signal(); }
  };
  return {signal, async close() {closed = true; clearTimeout(timer); await active;}};
}
