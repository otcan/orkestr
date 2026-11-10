// Reads a V1 thread's message pages for the scoped group relay, including the
// silent NO_REPLY finals that V1 hides from every other reader. A turn that
// answered NO_REPLY then closes its route at once instead of staying open until
// the route-age window (scoped-group-route-age.js) expires.
//
// The relay and V1 deploy separately. A V1 without the flag rejects the unknown
// query parameter with 400; the relay then reads the plain page (the previous
// behaviour, where such a route waits for the age window) and probes the flag
// again after FLAG_RETRY_MS. Any other 400 is a real error and is rethrown.
// A V1 that ignores the flag (another auth path) simply returns the filtered page.
export const FLAG_RETRY_MS = 10 * 60 * 1000;

// V1's schema rejection: "query.includeNoReply is not allowed".
const flagRejected = error => Number(error?.status || error?.statusCode || 0) === 400
  && /includeNoReply/.test(String(error?.payload?.error || error?.message || ''));

export function isSilentNoReply(message = {}) {
  if (String(message?.text || '').trim() === 'NO_REPLY') return true;
  return String(message?.visibility || '').trim().toLowerCase() === 'silent'
    && String(message?.silentReason || '').trim().toLowerCase() === 'no_reply';
}

export function createMessagePageReader({api, now = Date.now, log = () => {}}) {
  let unsupportedSince = null;
  const flagUsable = () => unsupportedSince === null || now() - unsupportedSince >= FLAG_RETRY_MS;
  return async function readPage(threadId, {limit = 200, before = ''} = {}) {
    const base = `/api/threads/${encodeURIComponent(threadId)}/messages?limit=${limit}${before ? `&before=${before}` : ''}`;
    if (flagUsable()) {
      try {
        const page = await api(`${base}&includeNoReply=1`);
        if (unsupportedSince !== null) log({event: 'relay_no_reply_pages_supported'});
        unsupportedSince = null;
        return page;
      } catch (error) {
        if (!flagRejected(error)) throw error;
        if (unsupportedSince === null) log({event: 'relay_no_reply_pages_unsupported'});
        unsupportedSince = now();
      }
    }
    return api(base);
  };
}
