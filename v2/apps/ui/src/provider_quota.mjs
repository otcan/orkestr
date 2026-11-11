// Display-only passive quota model. Login status never implies quota availability.
// Each card has one state (ORK-786): current, stale, expired, unknown (nothing
// verified was reported) or disconnected (the read itself failed). The summary
// names a state once; it never repeats "unavailable" or shows old values as live.
const PROVIDERS = [['codex','OpenAI / Codex','Codex'],['claude','Claude','Claude']];
const STATE_NOTE = {
 current: 'Passive telemetry, current.',
 stale: 'Stale: the newest observation is older than the freshness limit. Values are the last ones reported.',
 expired: 'Expired: every reported window has reset since it was observed. Waiting for passive telemetry.',
 unknown: 'Not reported: no verified quota observation yet.',
 disconnected: 'Disconnected: the quota read failed. Retrying; no values are shown until a read succeeds.',
};
function summaryChip(state, limited, label) {
 return [state === 'stale' ? 'stale' : '', limited && !label.includes('limited') ? 'limited' : ''].filter(Boolean).join(' · ');
}
export function disconnectedCards() {
 return PROVIDERS.map(([,name,short]) => ({name, short, state:'disconnected', limited:false, label:'Disconnected', chip:'', status:'disconnected', reset:'', note:STATE_NOTE.disconnected, detail:STATE_NOTE.disconnected}));
}
export function quotaCards(snapshot, now = Date.now()) {
 const configuredAge = snapshot?.staleAfterMs;
 const ageLimit = Number.isSafeInteger(configuredAge) && configuredAge >= 0 && configuredAge <= 604800000 ? configuredAge : 21600000;
 const epoch = x => typeof x === 'string' && x.length <= 40 ? Date.parse(x) : NaN;
 const countdown = at => { const m = Math.max(1, Math.ceil((at - now) / 60000)); return m >= 1440 ? `${Math.floor(m/1440)}d ${Math.floor((m%1440)/60)}h` : m >= 60 ? `${Math.floor(m/60)}h ${m%60}m` : `${m}m`; };
 const statusLabel = {allowed:'available',allowed_warning:'near limit',rejected:'limited'};
 return PROVIDERS.map(([key,name,short]) => {
  const q = snapshot?.quota?.[key];
  const observed = epoch(q?.observedAt);
  const knownObservation = Number.isFinite(observed) && observed > 0 && observed <= now;
  const stale = q?.stale === true || (knownObservation && now - observed > ageLimit);
  const reported = [['fiveHour','5h'],['weekly','week']].flatMap(([prefix,label]) => {
   const n = q?.[`${prefix}RemainingPct`], rawReset = q?.[`${prefix}ResetsAt`], at = epoch(rawReset);
   const status = Object.hasOwn(statusLabel,q?.[`${prefix}Status`]) ? statusLabel[q[`${prefix}Status`]] : null;
   // Null/absent windows are not subscription limits. Do not invent a 5h row.
   if (n == null && rawReset == null && !status) return [];
   const expired = Number.isFinite(at) && at <= now;
   const numeric = typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100;
   const valid = knownObservation && !expired && (numeric || status !== null);
   const value = numeric ? `${Math.round(n)}%` : status;
   return [{label: `${label} ${value}`, detail: `${label}: ${expired ? 'expired observation; waiting for passive telemetry' : valid ? `${value}${numeric ? ' remaining' : ''}` : 'no verified quota observation'}${Number.isFinite(at) && !expired ? `; resets in ${countdown(at)} (${new Date(at).toISOString()})` : '; reset time not reported'}`, reset: Number.isFinite(at) && !expired ? `${label} resets in ${countdown(at)}` : '', valid, expired}];
  });
  const windows = reported.filter(w => w.valid);
  const expired = reported.some(w => w.expired);
  const limited = q?.limited === true || windows.some(w => w.label.endsWith(' limited'));
  const state = windows.length ? stale ? 'stale' : 'current' : expired ? 'expired' : 'unknown';
  const label = windows.length ? windows.map(w=>w.label).join(' · ') : expired ? 'Telemetry expired' : 'Not reported';
  return {name, short, state, limited, label, chip: summaryChip(state, limited, label), status: `${state}${limited ? ' · limited' : ''}`, note: STATE_NOTE[state], reset: windows.map(w=>w.reset).filter(Boolean).join(' · '), detail: [!reported.length ? 'No passive quota telemetry. Account connection is separate from quota reporting.' : '', ...reported.map(w=>w.detail), knownObservation ? `Observed ${new Date(observed).toISOString()}${stale ? ' (stale)' : ''}` : 'No verified observation time'].filter(Boolean).join(' · ')};
 });
}
export async function providerQuotaRequest(signal, fetcher = fetch, now = () => Date.now()) {
 const controller = new AbortController(), cancel = () => controller.abort();
 signal?.addEventListener('abort', cancel, {once:true});
 if (signal?.aborted) cancel();
 const timer = setTimeout(cancel, 10000);
 let reader;
 try {
  const response = await fetcher('/api/v2/provider-quotas', {method:'GET', credentials:'same-origin', redirect:'error', cache:'no-store', signal:controller.signal});
  if(response.status !== 200 || !response.body) { await response.body?.cancel(); return {status:response.status, cards:disconnectedCards()}; }
  reader=response.body.getReader();let size=0,text='';const decoder=new TextDecoder('utf-8',{fatal:true});
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>16384)throw Error('Quota response too large');text+=decoder.decode(value,{stream:true});}
  text+=decoder.decode();return {status:200,cards:quotaCards(JSON.parse(text),now())};
 } catch { return {status:0,cards:disconnectedCards()}; }
 finally {clearTimeout(timer);signal?.removeEventListener('abort',cancel);await reader?.cancel().catch(()=>{});}
}
