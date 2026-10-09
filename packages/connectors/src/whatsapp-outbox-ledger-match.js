// Matching between WhatsApp connector-outbox jobs and the WhatsApp delivery
// ledger (outbound deliveries and outbound intents).
//
// Reconciliation checks every unresolved outbox job against the whole ledger.
// With thousands of jobs and ledger entries a linear scan per job dominated the
// server's CPU, so the ledger is indexed once per pass by every key a match can
// be decided on. Lookups return exactly what the linear scans returned.

function pickString(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function sameSourceMessage(job = {}, item = {}) {
  const sourceMessageId = pickString(job.sourceMessageId, job.sourceEventId);
  if (!sourceMessageId) return false;
  return sourceMessageId === pickString(item.sourceMessageId, item.messageId) ||
    sourceMessageId === pickString(item.messageId);
}

export function connectorOutboxJobIntentMatches(job = {}, intent = {}) {
  const jobId = pickString(job.id);
  if (jobId && pickString(intent.connectorOutboxJobId) === jobId) return true;
  const routerOutboxId = pickString(job.metadata?.routerOutboxId);
  if (routerOutboxId && pickString(intent.outboxId) === routerOutboxId) return true;
  return sameSourceMessage(job, intent) &&
    (!job.chatId || pickString(intent.chatId) === pickString(job.chatId)) &&
    (!job.accountId || pickString(intent.accountId) === pickString(job.accountId)) &&
    (!job.deliveryType || pickString(intent.deliveryType) === pickString(job.deliveryType));
}

export function connectorOutboxJobDeliveryMatches(job = {}, delivery = {}, { ignoreTextKey = false } = {}) {
  const jobId = pickString(job.id);
  if (jobId && pickString(delivery.connectorOutboxJobId) === jobId) return true;
  const routerOutboxId = pickString(job.metadata?.routerOutboxId);
  if (routerOutboxId && pickString(delivery.outboxId) === routerOutboxId) return true;
  return sameSourceMessage(job, delivery) &&
    (!job.chatId || pickString(delivery.chatId) === pickString(job.chatId)) &&
    (!job.accountId || pickString(delivery.accountId) === pickString(job.accountId)) &&
    (!job.deliveryType || pickString(delivery.deliveryType) === pickString(job.deliveryType)) &&
    (ignoreTextKey || !job.metadata?.textKey || pickString(delivery.textKey) === pickString(job.metadata.textKey));
}

// Every ledger item a job can match shares at least one of these keys with it,
// so the candidates for a job are the union of the per-key buckets.
function indexLedger(items = []) {
  const byJobId = new Map();
  const byOutboxId = new Map();
  const bySource = new Map();
  const add = (map, key, index) => {
    if (!key) return;
    const bucket = map.get(key);
    if (bucket) {
      if (bucket[bucket.length - 1] !== index) bucket.push(index);
    } else {
      map.set(key, [index]);
    }
  };
  items.forEach((item, index) => {
    add(byJobId, pickString(item?.connectorOutboxJobId), index);
    add(byOutboxId, pickString(item?.outboxId), index);
    add(bySource, pickString(item?.sourceMessageId, item?.messageId), index);
    add(bySource, pickString(item?.messageId), index);
  });
  return { items, byJobId, byOutboxId, bySource };
}

function candidateIndexes(index, job = {}) {
  const keys = [
    [index.byJobId, pickString(job.id)],
    [index.byOutboxId, pickString(job.metadata?.routerOutboxId)],
    [index.bySource, pickString(job.sourceMessageId, job.sourceEventId)],
  ];
  const candidates = new Set();
  for (const [map, key] of keys) {
    if (!key) continue;
    for (const position of map.get(key) || []) candidates.add(position);
  }
  return [...candidates];
}

function findMatch(index, job, matches, { last = true } = {}) {
  const positions = candidateIndexes(index, job).sort((left, right) => (last ? right - left : left - right));
  for (const position of positions) {
    const item = index.items[position];
    if (matches(job, item)) return item;
  }
  return null;
}

export function createConnectorOutboxLedgerIndex(outboundDeliveries = [], outboundIntents = []) {
  const deliveries = indexLedger(Array.isArray(outboundDeliveries) ? outboundDeliveries : []);
  const intents = indexLedger(Array.isArray(outboundIntents) ? outboundIntents : []);
  return {
    // Same result as scanning the ledger newest-first.
    latestDelivery(job) {
      return findMatch(deliveries, job, (candidate, item) => connectorOutboxJobDeliveryMatches(candidate, item));
    },
    latestDeliveredIntent(job) {
      return findMatch(intents, job, (candidate, item) =>
        connectorOutboxJobIntentMatches(candidate, item) && pickString(item?.status).toLowerCase() === "delivered");
    },
    // Same result as scanning intents oldest-first.
    firstIntent(job) {
      return findMatch(intents, job, connectorOutboxJobIntentMatches, { last: false });
    },
  };
}
