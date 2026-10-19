// Export is a distinct, bounded file offer; no revision parse or local storage.
export function offerMemoryExport(text, env = {document, URL, Blob, setTimeout}, allowed = () => false) {
 if (typeof text !== 'string' || new TextEncoder().encode(text).length > 8388608) throw Error('Memory export too large');
 if (!allowed()) throw Error('Memory export retired');
 const url = env.URL.createObjectURL(new env.Blob([text], {type:'application/json'}));
 const a = env.document.createElement('a');
 try {a.href=url;a.download='memory-export.json';env.document.body.append(a);if (!allowed()) throw Error('Memory export retired');a.click();}
 finally {a.remove();env.setTimeout(()=>env.URL.revokeObjectURL(url),1000);}
}
