// Export is a distinct, bounded file offer; no revision parse or local storage.
export function offerMemoryExport(text, env = {document, URL, Blob, setTimeout}) {
 if (typeof text !== 'string' || new TextEncoder().encode(text).length > 8388608) throw Error('Memory export too large');
 const url = env.URL.createObjectURL(new env.Blob([text], {type:'application/json'}));
 const a = env.document.createElement('a');
 try {a.href=url;a.download='memory-export.json';env.document.body.append(a);a.click();}
 finally {a.remove();env.setTimeout(()=>env.URL.revokeObjectURL(url),1000);}
}
