// Runs in the synthetic page. Observe the actual Send fetch without CDP body retention.
// No replay, replacement response, credential access or extra HTTP request.
export function installIntakeCapture(path, target = globalThis) {
  const original = target.fetch;
  target.__orkestrCIReceipt = {state:'waiting'};
  target.fetch = function(resource, options) {
    const matches = resource === path && options?.method === 'POST';
    const pending = original.call(this, resource, options);
    if (matches) {
      target.fetch = original;
      target.__orkestrCIReceipt = {state:'reading'};
      pending.then(async response => {
        const reader = response.clone().body?.getReader();
        if (!reader) throw new Error('Receipt body missing');
        const decoder = new TextDecoder(); let bytes = 0; let reads = 0; let text = '';
        try {
          while (true) {
            if (++reads > 128) throw new Error('Receipt read budget exceeded');
            const {done,value} = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > 8192) throw new Error('Receipt exceeds limit');
            text += decoder.decode(value, {stream:true});
          }
          text += decoder.decode();
          target.__orkestrCIReceipt = {state:'complete',status:response.status,body:JSON.parse(text)};
        } finally { void reader.cancel().catch(() => {}); }
      }).catch(() => { target.__orkestrCIReceipt = {state:'failed'}; });
    }
    return pending;
  };
}
