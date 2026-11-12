// Protected accepted-reply bytes; provenance is validated by the typed caller.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function boundedRead(path, signal, fetcher, limit, maxReads) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, {once: true});
    if (signal?.aborted) abort();
    const timeout = setTimeout(abort, 10000);
    let reader;
    try {
        const response = await fetcher(path, {
            credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
        });
        if (response.status !== 200) {
            await response.body?.cancel();
            return {status: response.status, text: ''};
        }
        reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8', {fatal: true});
        let bytes = 0, text = '';
        for (let reads = 0; reads < maxReads; reads++) {
            const {done, value} = await reader.read();
            if (done) return {status: 200, text: text + decoder.decode()};
            bytes += value.byteLength;
            if (bytes > limit) throw new Error('Reply exceeds limit');
            text += decoder.decode(value, {stream: true});
        }
        throw new Error('Reply read limit exceeded');
    } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
        controller.abort();
        await reader?.cancel().catch(() => {});
    }
}

export async function acceptedPayload({conversation, payload, signal}, fetcher = fetch) {
    if (!UUID.test(conversation) || !UUID.test(payload)) throw new Error('Invalid reply identity');
    return boundedRead(`/api/v2/conversations/${conversation}/payloads/${payload}`, signal, fetcher, 1048576, 4096);
}

// Several replies in one read (ORK-797); the server leaves out what it cannot send.
export async function acceptedPayloads({conversation, payloads, signal}, fetcher = fetch) {
    if (!UUID.test(conversation) || !Array.isArray(payloads) || payloads.length < 1 || payloads.length > 50
        || !payloads.every(payload => typeof payload === 'string' && UUID.test(payload))
        || new Set(payloads.map(payload => payload.toLowerCase())).size !== payloads.length) throw new Error('Invalid reply identity');
    return boundedRead(`/api/v2/conversations/${conversation}/payloads?ids=${payloads.join(',')}`, signal, fetcher, 2097152, 8192);
}
