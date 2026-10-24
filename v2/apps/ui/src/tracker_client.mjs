// Local recovery records contain opaque owner decisions, never paths or credentials.
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const decisions = {
  selection: ['request_key', 'expected_revision', 'source', 'acknowledge_read_only_access'],
  source_remove: ['request_key', 'expected_revision'],
  check: ['request_key', 'expected_source_revision', 'expected_recipe', 'expected_classifier_id', 'expected_classifier_digest'],
  automation_enable: ['request_key', 'expected_revision', 'expected_timer_revision', 'expected_source_revision', 'expected_recipe', 'expected_classifier_id', 'expected_classifier_digest', 'calendar', 'acknowledge_automation'],
  automation_disable: ['request_key', 'expected_revision', 'expected_timer_revision'],
};
function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('|') === [...keys].sort().join('|');
}
function validDecision(kind, body) {
  if (!decisions[kind] || !exactKeys(body, decisions[kind]) || !uuidPattern.test(body.request_key)) return false;
  for (const field of ['expected_revision', 'expected_source_revision']) {
    if (field in body && (!Number.isSafeInteger(body[field]) || body[field] < 0)) return false;
  }
  if ('expected_timer_revision' in body && body.expected_timer_revision !== null && (!Number.isSafeInteger(body.expected_timer_revision) || body.expected_timer_revision < 1)) return false;
  if ('expected_recipe' in body && body.expected_recipe !== 'job-tracker') return false;
  if ('expected_classifier_digest' in body && !/^[0-9a-f]{64}$/.test(body.expected_classifier_digest)) return false;
  if ('expected_classifier_id' in body && (typeof body.expected_classifier_id !== 'string' || body.expected_classifier_id.length > 80)) return false;
  if (kind === 'automation_enable' && (!body.acknowledge_automation || !exactKeys(body.calendar, ['timezone', 'weekdays', 'start_minute', 'end_minute', 'every_hours', 'minutes']))) return false;
  if (kind === 'selection' && body.acknowledge_read_only_access !== true) return false;
  if (kind === 'selection') {
    const source = body.source;
    if (!exactKeys(source, ['source_id', 'inbox', 'sent']) || !uuidPattern.test(source.source_id)) return false;
    if (![source.inbox, source.sent].every(a => Array.isArray(a) && a.length > 0 && a.every(id => uuidPattern.test(id)))) return false;
    if (source.inbox.length + source.sent.length > 8 || new Set([...source.inbox, ...source.sent]).size !== source.inbox.length + source.sent.length) return false;
  }
  return JSON.stringify(body).length <= 16000;
}

export function trackerJournal(storage, binding, conversation) {
  if (!uuidPattern.test(binding) || !uuidPattern.test(conversation)) throw new Error('Chat unavailable.');
  const prefix = `orkestr.tracker.pending.v1:${binding}:${conversation}:`;
  const keys = () => Array.from({length: storage.length}, (_, n) => storage.key(n)).filter(k => typeof k === 'string' && k.startsWith(prefix));
  return {
    load() {
      return keys().slice(0, 8).map(key => {
        try {
          const value = JSON.parse(storage.getItem(key));
          return validDecision(value.kind, value.body) && key === prefix + value.body.request_key ? value : null;
        } catch { return null; }
      }).filter(Boolean);
    },
    save(kind, body) {
      if (!validDecision(kind, body)) throw new Error('The recovery record is invalid.');
      const key = prefix + body.request_key;
      const stored = storage.getItem(key);
      if (stored !== null) {
        const old = JSON.parse(stored);
        if (old.kind !== kind || JSON.stringify(old.body) !== JSON.stringify(body)) throw new Error('This decision already has different details.');
        return old;
      }
      if (keys().length >= 8) throw new Error('Resolve an interrupted tracker change before starting another.');
      const value = {kind, body};
      storage.setItem(key, JSON.stringify(value));
      if (storage.getItem(key) !== JSON.stringify(value)) throw new Error('Could not save the recovery record in this browser.');
      return value;
    },
    clear(key) {
      if (!uuidPattern.test(key)) throw new Error('Invalid recovery record.');
      storage.removeItem(prefix + key);
    },
  };
}

const trackerUuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const trackerBase = `/api/v2/conversations/${trackerUuid}/tracker`;
const trackerRoutes = [
  ['GET', new RegExp(`^${trackerBase}(?:/(?:mail-status|scan-reports|automation))?$`)],
  ['PUT', new RegExp(`^${trackerBase}(?:/mail-source)?$`)],
  ['POST', new RegExp(`^${trackerBase}/(?:mail-sources|check|automation|merge|rows/${trackerUuid})$`)],
  ['DELETE', new RegExp(`^${trackerBase}/(?:mail-source|automation|checks/${trackerUuid})$`)],
  ['GET', new RegExp(`^${trackerBase}/(?:checks/${trackerUuid}|mail-source/decisions/${trackerUuid}|automation/decisions/${trackerUuid}|rows/${trackerUuid}/events)$`)],
];

export async function trackerRequest(input, fetchImpl = globalThis.fetch, signal) {
  if (!trackerRoutes.some(([method, route]) => method === input.method && route.test(input.path))) throw new Error('Tracker operation unavailable.');
  const writing = input.method !== 'GET';
  if (writing && (typeof input.csrf !== 'string' || !input.csrf)) throw new Error('Sign in again to change the tracker.');
  const response = await fetchImpl(input.path, {
    method: input.method, credentials: 'same-origin', cache: 'no-store', signal,
    headers: writing ? {'x-orkestr-csrf': input.csrf, 'Content-Type': 'application/json'} : {},
    ...(writing && input.body !== null ? {body: JSON.stringify(input.body)} : {}),
  });
  const reader = response.body.getReader();
  const decoder = new TextDecoder(); let bytes = 0, text = '';
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) { text += decoder.decode(); break; }
      bytes += value.byteLength;
      if (bytes > 4 * 1024 * 1024) throw new Error('Tracker response exceeds the display limit.');
      text += decoder.decode(value, {stream: true});
    }
  } finally { await reader.cancel().catch(() => {}); }
  let body;
  try { body = JSON.parse(text); } catch { throw new Error('The tracker response was interrupted. Check its status before retrying.'); }
  return {status: response.status, body};
}
