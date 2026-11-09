// Keep a failed paste's File only while its textarea exists, so an unchanged
// retry can resume the same encrypted upload. No text or file bytes enter
// session/local storage or the Rust bridge.
const drafts = new WeakMap();

export async function uploadPastedText(element, describe, {scope = ''} = {}) {
  if (!element || typeof element.value !== 'string' || !element.value.length) {
    return {error: 'Enter text to attach first.'};
  }
  let draft = drafts.get(element);
  if (!draft || draft.text !== element.value || draft.scope !== scope) {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
    const name = `pasted-text-${stamp}-${crypto.randomUUID().slice(0, 8)}.txt`;
    try {
      draft = {scope, text: element.value, file: new File([element.value], name, {type: 'text/plain'})};
    } catch {
      return {error: 'Text could not be prepared as a file.'};
    }
    drafts.set(element, draft);
  }
  if (draft.pending) return draft.pending;
  const pending = (async () => {
    try {
      const result = await describe([draft.file]);
      if (!result.error && drafts.get(element) === draft) drafts.delete(element);
      return result;
    } catch (error) {
      return {error: error.message || 'Text upload interrupted. Retry to resume.'};
    }
  })();
  draft.pending = pending;
  try { return await pending; }
  finally { if (draft.pending === pending) delete draft.pending; }
}
