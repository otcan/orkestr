// Read-only list badges: one bounded execution and queue read per listed conversation.
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
async function readOne(path, signal, fetcher, limit = 65536) {
 const controller = new AbortController(), cancel = () => controller.abort();
 signal?.addEventListener('abort', cancel, {once:true});
 if (signal?.aborted) cancel();
 const timer = setTimeout(cancel, 10000);
 let reader;
 try {
  const response = await fetcher(path, {method:'GET', credentials:'same-origin', redirect:'error', cache:'no-store', signal:controller.signal, headers:{}});
  if (response.status !== 200 || !response.body) { await response.body?.cancel(); return {status:response.status, text:''}; }
  reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', {fatal:true});
  let text = '', bytes = 0;
  for (let reads = 0; reads < 4096; reads++) {
   const {done, value} = await reader.read();
   if (done) return {status:200, text:text + decoder.decode()};
   bytes += value.byteLength;
   if (bytes > limit) return {status:0, text:''};
   text += decoder.decode(value, {stream:true});
  }
  return {status:0, text:''};
 } catch (error) {
  if (signal?.aborted) throw error;
  return {status:0, text:''};
 } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); await reader?.cancel().catch(() => {}); }
}
function batchRead(read) {
 const status = Number.isInteger(read?.status) ? read.status : 0;
 const text = status === 200 && read.body !== null && read.body !== undefined ? JSON.stringify(read.body) : '';
 return {status: text.length > 65536 ? 0 : status, text: text.length > 65536 ? '' : text};
}
function batchRows(text, conversations) {
 let rows;
 try { rows = JSON.parse(text).rows; } catch { return null; }
 if (!Array.isArray(rows) || rows.length !== conversations.length || !rows.every((row, i) => row?.id === conversations[i])) return null;
 return rows.map(row => ({id:row.id, execution:batchRead(row.execution), queue:batchRead(row.queue)}));
}
export async function conversationStatusRequest({conversations, signal}, fetcher = fetch) {
 if (!Array.isArray(conversations) || conversations.length > 50 || new Set(conversations).size !== conversations.length
  || !conversations.every(id => typeof id === 'string' && uuid.test(id))) throw Error('Invalid conversation list');
 // One request for the whole list. A server without the batch endpoint (404)
 // or an unexpected reply falls back to two reads per conversation.
 const batch = await readOne(`/api/v2/conversation-status?ids=${conversations.join(',')}`, signal, fetcher, 1048576);
 if (batch.status === 200) {
  const rows = batchRows(batch.text, conversations);
  if (rows) return rows;
 }
 if (batch.status === 401) return conversations.map(id => ({id, execution:{status:401, text:''}, queue:{status:401, text:''}}));
 const results = [];
 for (const id of conversations) {
  const execution = await readOne(`/api/v2/conversations/${id}/execution`, signal, fetcher);
  const queue = await readOne(`/api/v2/conversations/${id}/window/queue`, signal, fetcher);
  results.push({id, execution, queue});
 }
 return results;
}
