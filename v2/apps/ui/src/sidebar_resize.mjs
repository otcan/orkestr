// Bounded, keyboard-operable resizing of the conversation list (ORK-786).
// The width is a CSS variable on the workspace and, per viewer, a
// localStorage value. CSS clamps it again, so no stored value can break the
// layout. Pointer drag and the arrow keys use the same bounds.
export const MIN = 240;
export const MAX = 480;
export const STEP = 16;
export const KEY = 'orkestr.v2.sidebarWidth';

// The list never takes more than 45% of the window.
export function maxWidth(viewport) {
  return Math.max(MIN, Math.min(MAX, Math.floor(Number(viewport) * 0.45) || MIN));
}

export function clampWidth(px, viewport) {
  if (px === null || px === undefined || px === '') return null;
  const value = Number(px);
  if (!Number.isFinite(value)) return null;
  return Math.max(MIN, Math.min(maxWidth(viewport), Math.round(value)));
}

// Window-splitter keys: arrows move one step, Home and End go to the bounds.
export function keyWidth(current, key, viewport) {
  switch (key) {
    case 'ArrowLeft': return clampWidth(current - STEP, viewport);
    case 'ArrowRight': return clampWidth(current + STEP, viewport);
    case 'Home': return MIN;
    case 'End': return maxWidth(viewport);
    default: return null;
  }
}

export function installResize(handle, workspace, env = globalThis) {
  if (!handle || !workspace || handle.dataset.resizeInstalled === 'true') return null;
  handle.dataset.resizeInstalled = 'true';
  let storage = null;
  try { storage = env.localStorage ?? null; } catch { storage = null; }
  const viewport = () => env.innerWidth || 1280;
  const current = () => clampWidth(workspace.querySelector('.conversation-sidebar')?.getBoundingClientRect().width || MIN, viewport());
  const label = width => {
    handle.setAttribute('aria-valuemin', String(MIN));
    handle.setAttribute('aria-valuemax', String(maxWidth(viewport())));
    handle.setAttribute('aria-valuenow', String(width));
    handle.setAttribute('aria-valuetext', `${width} pixels wide`);
  };
  const apply = (px, save) => {
    const width = clampWidth(px, viewport());
    if (width === null) return null;
    workspace.style.setProperty('--sidebar-width', `${width}px`);
    label(width);
    if (save) { try { storage?.setItem(KEY, String(width)); } catch { /* storage blocked */ } }
    return width;
  };
  let stored = null;
  try { stored = storage?.getItem(KEY) ?? null; } catch { stored = null; }
  if (apply(stored, false) === null) label(current());
  handle.addEventListener('keydown', event => {
    const next = keyWidth(current(), event.key, viewport());
    if (next === null) return;
    event.preventDefault();
    apply(next, true);
  });
  handle.addEventListener('pointerdown', event => {
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault();
    const start = event.clientX, from = current();
    let last = from;
    try { handle.setPointerCapture?.(event.pointerId); } catch { /* not capturable */ }
    workspace.dataset.resizing = 'true';
    const move = e => { last = apply(from + e.clientX - start, false) ?? last; };
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      delete workspace.dataset.resizing;
      apply(last, true);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  });
  // Double-click restores the default width.
  handle.addEventListener('dblclick', () => {
    workspace.style.removeProperty('--sidebar-width');
    try { storage?.removeItem(KEY); } catch { /* storage blocked */ }
    label(current());
  });
  return { apply, current };
}
