export async function acceptedResults({conversation, after, signal}, fetcher = fetch) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(conversation) || typeof after !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(after) || BigInt(after) > 9223372036854775807n) throw new Error('Invalid history cursor');
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, {once:true});
    if (signal?.aborted) abort();
    const timeout = setTimeout(abort, 10000);
    let reader;
    try {
        const response = await fetcher(`/api/v2/conversations/${conversation}/accepted-results?after_sequence=${after}&limit=20`, {
            credentials:'same-origin', cache:'no-store', redirect:'error', signal:controller.signal,
        });
        if (response.status !== 200) { await response.body?.cancel(); return {status:response.status,text:''}; }
        reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8',{fatal:true});
        let text='', bytes=0;
        for(let reads=0;reads<1024;reads++) {
            const {done,value}=await reader.read();
            if(done) return {status:200,text:text+decoder.decode()};
            bytes+=value.byteLength;
            if(bytes>65536) throw new Error('Reply history exceeds limit');
            text+=decoder.decode(value,{stream:true});
        }
        throw new Error('Reply history read limit');
    } finally { clearTimeout(timeout); signal?.removeEventListener('abort',abort); controller.abort(); await reader?.cancel().catch(()=>{}); }
}
