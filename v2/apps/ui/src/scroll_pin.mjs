// Keeps a transcript pinned to its newest message while the reader is at the
// bottom; scrolling up releases the pin until the reader returns (or jumps).
// `data-pinned` on the element drives the "Jump to latest" control.
export const THRESHOLD = 72;

export function installPin(el, env = globalThis) {
  if (!el || el.dataset.pinInstalled === 'true') return null;
  el.dataset.pinInstalled = 'true';
  let pinned = true;
  const set = value => { pinned = value; el.dataset.pinned = String(value); };
  const atBottom = () => el.scrollHeight - el.scrollTop - el.clientHeight <= THRESHOLD;
  const bottom = () => { el.scrollTop = el.scrollHeight; set(true); };
  el.addEventListener('scroll', () => set(atBottom()), { passive: true });
  const follow = () => { if (pinned) bottom(); };
  const mutations = new env.MutationObserver(follow);
  mutations.observe(el, { childList: true, subtree: true, characterData: true });
  const sizes = env.ResizeObserver ? new env.ResizeObserver(follow) : null;
  sizes?.observe(el);
  bottom();
  return { bottom, pinned: () => pinned, stop: () => { mutations.disconnect(); sizes?.disconnect(); } };
}
