// Read-only owner live map: one bounded, cookie-only GET per refresh.
export const LIVE_MAP_LIMIT = 4 * 1024 * 1024;
export async function liveMapRequest({signal} = {}, fetcher = fetch) {
 const controller = new AbortController(), cancel = () => controller.abort();
 signal?.addEventListener('abort', cancel, {once:true});
 if (signal?.aborted) cancel();
 const timer = setTimeout(cancel, 10000);
 let reader;
 try {
  const response = await fetcher('/api/v2/live-map', {method:'GET', credentials:'same-origin', redirect:'error', cache:'no-store', signal:controller.signal, headers:{}});
  if (response.status !== 200 || !response.body) { await response.body?.cancel(); return {status:response.status, text:''}; }
  reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', {fatal:true});
  let text = '', bytes = 0;
  while (true) {
   const {done, value} = await reader.read();
   if (done) return {status:200, text:text + decoder.decode()};
   bytes += value.byteLength;
   if (bytes > LIVE_MAP_LIMIT) return {status:0, text:''};
   text += decoder.decode(value, {stream:true});
  }
 } catch (error) {
  if (signal?.aborted) throw error;
  return {status:0, text:''};
 } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); await reader?.cancel().catch(() => {}); }
}
