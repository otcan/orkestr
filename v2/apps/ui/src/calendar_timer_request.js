// Calendar timer owner operations: fixed same-origin paths; no clock, generation or claim inputs.
const input = await dioxus.recv();
const uuid = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const routes = [
 ['POST', new RegExp('^/api/v2/timers/calendar(?:/preview)?$')],
 ['POST', new RegExp(`^/api/v2/timers/${uuid}/(?:schedule|pause)$`)],
 ['PUT', new RegExp(`^/api/v2/timers/${uuid}/policy$`)],
 ['POST', new RegExp(`^/api/v2/conversations/${uuid}/timer-pause$`)],
];
if (!input.csrf || !routes.some(([method, route]) => input.method === method && route.test(input.path))) throw new Error('Timer operation unavailable');
const forbidden = ['due_ms', 'next_due_ms', 'generation', 'claim_id', 'claim', 'now'];
if (!input.body || typeof input.body !== 'object' || Array.isArray(input.body) || forbidden.some((key) => key in input.body)) throw new Error('Invalid timer fields');
const controller = new AbortController(); let finished = false;
dioxus.recv().then(() => { if (!finished) controller.abort(); });
const timer = setTimeout(() => controller.abort(), 15000);
try {
 const response = await fetch(input.path, {method: input.method, credentials: 'same-origin', cache: 'no-store', signal: controller.signal, headers: {'x-orkestr-csrf': input.csrf, 'Content-Type': 'application/json'}, body: JSON.stringify(input.body)});
 if (response.status !== 200) {
  let message = null;
  try { message = JSON.parse(await response.text()).message ?? null; } catch { message = null; }
  return {status: response.status, body: null, message: typeof message === 'string' ? message.slice(0, 200) : null};
 }
 const reader = response.body.getReader(); const decoder = new TextDecoder(); let bytes = 0, text = '';
 try { while (true) { const {done, value} = await reader.read(); if (done) { text += decoder.decode(); break; } bytes += value.byteLength; if (bytes > 65536) throw new Error('Timer response exceeds limit'); text += decoder.decode(value, {stream: true}); } }
 finally { await reader.cancel().catch(() => {}); }
 return {status: 200, body: JSON.parse(text)};
} finally { finished = true; clearTimeout(timer); controller.abort(); }
