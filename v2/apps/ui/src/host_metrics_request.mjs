// Owner host metrics: one bounded, cookie-only GET that revalidates with the
// last ETag; 304 answers carry no body and the caller keeps its copy.
export const HOST_METRICS_LIMIT = 2 * 1024 * 1024;
const paths = /^\/api\/v2\/(?:host-metrics(?:\/history\?range=(?:15m|1h|24h|7d)|\/consumers|\/disks)?|host\/ai-usage)$/;
export async function hostMetricsRequest({path, etag, signal} = {}, fetcher = fetch) {
 if (typeof path !== 'string' || !paths.test(path)) throw Error('Invalid host metrics path');
 const controller = new AbortController(), cancel = () => controller.abort();
 signal?.addEventListener('abort', cancel, {once:true});
 if (signal?.aborted) cancel();
 const timer = setTimeout(cancel, 10000);
 const headers = typeof etag === 'string' && /^(?:W\/)?"[^"\r\n]{1,128}"$/.test(etag) ? {'If-None-Match': etag} : {};
 let reader;
 try {
  const response = await fetcher(path, {method:'GET', credentials:'same-origin', redirect:'error', cache:'no-store', signal:controller.signal, headers});
  if (response.status !== 200 || !response.body) { await response.body?.cancel(); return {status:response.status, etag:null, text:''}; }
  reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', {fatal:true});
  let text = '', bytes = 0;
  while (true) {
   const {done, value} = await reader.read();
   if (done) return {status:200, etag:response.headers.get('etag'), text:text + decoder.decode()};
   bytes += value.byteLength;
   if (bytes > HOST_METRICS_LIMIT) return {status:0, etag:null, text:''};
   text += decoder.decode(value, {stream:true});
  }
 } catch (error) {
  if (signal?.aborted) throw error;
  return {status:0, etag:null, text:''};
 } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); await reader?.cancel().catch(() => {}); }
}
