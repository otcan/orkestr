// Read-only archived history page. Cursors stay exact decimal text until Rust decodes them.
export async function archivedHistoryRequest({conversation, after, limit, signal}, fetcher = fetch) {
 if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(conversation)) throw Error('Invalid conversation');
 if (typeof after !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(after) || BigInt(after) > 9223372036854775807n) throw Error('Invalid archive cursor');
 if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw Error('Invalid archive page size');
 const controller = new AbortController(), cancel = () => controller.abort();
 signal?.addEventListener('abort', cancel, {once:true});
 if (signal?.aborted) cancel();
 const timer = setTimeout(cancel, 15000);
 let reader;
 try {
  const response = await fetcher(`/api/v2/conversations/${conversation}/archived-history?after=${after}&limit=${limit}`, {
   method:'GET', credentials:'same-origin', redirect:'error', cache:'no-store', signal:controller.signal, headers:{},
  });
  if (response.status !== 200) { await response.body?.cancel(); return {status:response.status, text:''}; }
  if (!response.body) throw Error('Missing archive response');
  reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', {fatal:true});
  let text = '', bytes = 0;
  for (let reads = 0; reads < 4096; reads++) {
   const {done, value} = await reader.read();
   if (done) return {status:200, text:text + decoder.decode()};
   bytes += value.byteLength;
   // An oversized page is retried by Rust with a smaller limit, never truncated.
   if (bytes > 8 * 1024 * 1024) return {status:413, text:''};
   text += decoder.decode(value, {stream:true});
  }
  throw Error('Archive read budget exceeded');
 } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); await reader?.cancel().catch(() => {}); }
}
