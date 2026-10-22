// Long press on a message (touch screens) presses its Reply button, the
// way WhatsApp starts a reply. A move, a second finger or lifting early cancels.
export const HOLD_MS = 500;

export function installReplyGestures(doc, env = globalThis) {
  if (!doc || doc.__orkestrReplyGestures) return false;
  doc.__orkestrReplyGestures = true;
  let timer = null, start = null;
  const cancel = () => { if (timer) env.clearTimeout(timer); timer = null; start = null; };
  doc.addEventListener('touchstart', event => {
    cancel();
    const target = event.target;
    const row = target?.closest?.('[data-replyable="true"]');
    if (!row || event.touches.length !== 1 || target.closest('button, a, input, textarea, summary, details')) return;
    start = [event.touches[0].clientX, event.touches[0].clientY];
    timer = env.setTimeout(() => {
      timer = null;
      const button = row.querySelector('.reply-action');
      if (!button) return;
      env.navigator?.vibrate?.(15);
      button.click();
    }, HOLD_MS);
  }, { passive: true });
  doc.addEventListener('touchmove', event => {
    const touch = event.touches[0];
    if (timer && start && touch && Math.hypot(touch.clientX - start[0], touch.clientY - start[1]) > 10) cancel();
  }, { passive: true });
  doc.addEventListener('touchend', cancel, { passive: true });
  doc.addEventListener('touchcancel', cancel, { passive: true });
  return true;
}
