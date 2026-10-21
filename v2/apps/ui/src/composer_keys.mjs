// Enter sends; Shift+Enter inserts a newline. Never send while an input
// method is composing (isComposing, or keyCode 229 on older engines).
export function enterSends(event) {
  return event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey
    && !event.isComposing && event.keyCode !== 229;
}

export function installEnterSend(textarea) {
  if (!textarea || textarea.dataset.enterSend === 'true') return false;
  textarea.dataset.enterSend = 'true';
  textarea.addEventListener('keydown', event => {
    if (!enterSends(event)) return;
    event.preventDefault();
    const form = textarea.form;
    const submit = form?.querySelector('button[type=submit]');
    if (form && !submit?.disabled) form.requestSubmit(submit ?? undefined);
  });
  return true;
}
