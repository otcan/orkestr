// Put text on the clipboard. The Clipboard API needs a secure context (https
// or localhost); a plain-http host or an older browser gets a hidden, read-only
// textarea and the legacy copy command instead. Focus returns to where it was.
export async function copyText(text, env = globalThis) {
  const nav = env.navigator;
  const doc = env.document;
  if (nav?.clipboard?.writeText && env.isSecureContext !== false) {
    try {
      await nav.clipboard.writeText(text);
      return true;
    } catch {
      // Denied or unavailable: try the fallback below.
    }
  }
  if (!doc?.createElement || !doc.body) return false;
  const area = doc.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.setAttribute('aria-hidden', 'true');
  area.setAttribute('tabindex', '-1');
  Object.assign(area.style, {position: 'fixed', top: '0', left: '-9999px', opacity: '0'});
  const active = doc.activeElement;
  doc.body.appendChild(area);
  try {
    area.select();
    area.setSelectionRange?.(0, text.length);
    return doc.execCommand?.('copy') === true;
  } catch {
    return false;
  } finally {
    area.remove();
    active?.focus?.({preventScroll: true});
  }
}
