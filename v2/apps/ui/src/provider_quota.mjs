// Display-only passive quota model. No provider requests or account selectors.
export function quotaCards(snapshot, now = Date.now()) {
 const ageLimit = 6 * 60 * 60 * 1000;
 const epoch = x => typeof x === 'string' && x.length <= 40 ? Date.parse(x) : NaN;
 const countdown = at => { const m = Math.max(1, Math.ceil((at - now) / 60000)); return m >= 1440 ? `${Math.floor(m/1440)}d ${Math.floor((m%1440)/60)}h` : m >= 60 ? `${Math.floor(m/60)}h ${m%60}m` : `${m}m`; };
 return [['codex','OpenAI / Codex'],['claude','Claude']].map(([key,name]) => {
  const q = snapshot?.quota?.[key];
  const observed = epoch(q?.observedAt);
  const knownObservation = Number.isFinite(observed) && observed > 0 && observed <= now;
  const stale = q?.stale === true || (knownObservation && now - observed > ageLimit);
  const windows = [['fiveHour','5h'],['weekly','wk']].map(([prefix,label]) => {
   const n = q?.[`${prefix}RemainingPct`], at = epoch(q?.[`${prefix}ResetsAt`]);
   const expired = Number.isFinite(at) && at <= now;
   const valid = knownObservation && !expired && typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100;
   return {label: `${label} ${valid ? `${Math.round(n)}%` : '?'}`, detail: `${label}: ${expired ? 'expired observation; waiting for new telemetry' : valid ? `${Math.round(n)}% remaining` : 'unknown'}${Number.isFinite(at) && !expired ? `; resets in ${countdown(at)} (${new Date(at).toISOString()})` : '; reset time unknown'}`, valid};
  });
  const status = !q ? 'unavailable' : !windows.some(w=>w.valid) ? 'unknown' : stale ? 'stale' : 'current';
  return {name, label: windows.map(w=>w.label).join(' · '), status: `${status}${q?.limited === true ? ' · limited' : ''}`, detail: [...windows.map(w=>w.detail), knownObservation ? `Observed ${new Date(observed).toISOString()}` : 'No verified observation time'].join(' · ')};
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
  if(response.status !== 200 || !response.body) { await response.body?.cancel(); return {status:response.status, cards:quotaCards(null,now())}; }
  reader=response.body.getReader();let size=0,text='';const decoder=new TextDecoder('utf-8',{fatal:true});
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>16384)throw Error('Quota response too large');text+=decoder.decode(value,{stream:true});}
  text+=decoder.decode();return {status:200,cards:quotaCards(JSON.parse(text),now())};
 } catch { return {status:0,cards:quotaCards(null,now())}; }
 finally {clearTimeout(timer);signal?.removeEventListener('abort',cancel);await reader?.cancel().catch(()=>{});}
}
