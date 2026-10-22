// Current reaction snapshots through the supported Message API. No sendSeen,
// contact lookup, browser internals, or additional chat access is performed.
const MAX_REACTIONS = 200;
const idOf = value => typeof value === 'string' ? value : value?._serialized;
const unavailable = () => ({reactions: [], reactionsStatus: 'unavailable'});

function originOf(reaction, ownChatId) {
  const fromMe = reaction?.id?.fromMe;
  const sender = idOf(reaction?.senderId);
  if (typeof fromMe === 'boolean') {
    // A conflicting provider identity is not evidence of either sender.
    if (ownChatId && sender === ownChatId && fromMe === false) return null;
    return fromMe;
  }
  if (ownChatId && sender === ownChatId) return true;
  // PN and LID are different namespaces: never guess a mapping.
  return null;
}

export function normalizeReactions(message, buckets, {ownChatId} = {}) {
  const messageId = idOf(message?.id);
  if (!messageId || !Array.isArray(buckets)) return unavailable();
  const reactions = [];
  let partial = false;
  for (const bucket of buckets) {
    if (!Array.isArray(bucket?.senders)) { partial = true; continue; }
    for (const reaction of bucket.senders) {
      if (reactions.length >= MAX_REACTIONS) { partial = true; break; }
      const parent = idOf(reaction?.msgId);
      const emoji = reaction?.reaction;
      // Do not attribute a reaction for a different message, or an aggregate
      // hasReactionByMe flag (which can contain both our and their reactions).
      if ((parent && parent !== messageId) || typeof emoji !== 'string' || !emoji || emoji.length > 64) { partial = true; continue; }
      const fromMe = originOf(reaction, ownChatId);
      const seconds = Number(reaction?.timestamp);
      const ms = seconds * 1000;
      reactions.push({messageId, emoji, fromMe, origin: fromMe === null ? 'unknown' : fromMe ? 'us' : 'them',
        reactionId: idOf(reaction?.id) || null,
        timestamp: Number.isFinite(ms) && ms > 0 && ms <= 8.64e15 ? new Date(ms).toISOString() : null,
        ack: typeof reaction?.ack === 'number' && Number.isFinite(reaction.ack) ? reaction.ack : null});
    }
  }
  return {reactions, reactionsStatus: partial ? 'partial' : 'available'};
}

// A hung provider call cannot be cancelled. Each worker stops after a timeout,
// bounding outstanding calls as well as response time; never launch an entire
// history page of abandoned browser operations.
export async function readReactionSnapshots(messages, {ownChatId, timeoutMs = 750, budgetMs = 3000, concurrency = 4} = {}) {
  const results = messages.map(unavailable);
  let next = 0;
  const deadline = Date.now() + budgetMs;
  async function worker() {
    while (next < messages.length) {
      const index = next++;
      const message = messages[index];
      if (message?.hasReaction === false) {
        results[index] = {reactions: [], reactionsStatus: 'available'};
        continue;
      }
      if (typeof message?.getReactions !== 'function' || !idOf(message?.id)) continue;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      let timer;
      const timedOut = Symbol('timeout');
      try {
        const value = await Promise.race([
          Promise.resolve().then(() => message.getReactions()),
          new Promise(resolve => { timer = setTimeout(() => resolve(timedOut), Math.min(timeoutMs, remaining)); }),
        ]);
        if (value === timedOut) return;
        results[index] = normalizeReactions(message, value, {ownChatId});
      } catch { /* Failure is unavailable, never an asserted empty snapshot. */ }
      finally { clearTimeout(timer); }
    }
  }
  await Promise.all(Array.from({length: Math.min(concurrency, messages.length)}, worker));
  return results;
}

export async function serializeMessagesWithReactions(messages, serialize, options = {}) {
  const snapshots = await readReactionSnapshots(messages, options);
  return messages.map((message, index) => ({...serialize(message), ...snapshots[index]}));
}
