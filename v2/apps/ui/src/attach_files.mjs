// Reads files the owner picks (or pasted text) as base64 for the attachment
// upload. Nothing is sent from here; Rust posts the upload.
export const FILES_MAX = 8;
export const BYTES_MAX = 16 * 1024 * 1024;

export function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function safeName(name) {
  const base = String(name || 'file').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200);
  return base || 'file';
}

export async function describe(files) {
  const list = [...files];
  if (!list.length) return { files: [] };
  if (list.length > FILES_MAX) return { error: `Attach at most ${FILES_MAX} files at once.` };
  const total = list.reduce((sum, f) => sum + f.size, 0);
  if (total > BYTES_MAX) return { error: 'Attachments are limited to 16 MiB per message.' };
  const out = [];
  for (const file of list) {
    if (!file.size) return { error: `${safeName(file.name)} is empty or a folder.` };
    let bytes;
    try { bytes = new Uint8Array(await file.arrayBuffer()); }
    catch { return { error: `${safeName(file.name)} could not be read (folders cannot be attached).` }; }
    out.push({ filename: safeName(file.name), media_type: /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(file.type) ? file.type : 'application/octet-stream',
      content_base64: toBase64(bytes) });
  }
  return { files: out };
}

export function pastedText(text, now = new Date()) {
  const stamp = now.toISOString().slice(0, 19).replace(/[-:T]/g, '');
  const bytes = new TextEncoder().encode(text);
  return { filename: `pasted-text-${stamp}.txt`, media_type: 'text/plain', content_base64: toBase64(bytes) };
}

// Opens the browser file picker and resolves with the described files.
export function pick(document) {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file'; input.multiple = true; input.style.display = 'none';
    input.addEventListener('change', async () => { resolve(await describe(input.files)); input.remove(); }, { once: true });
    input.addEventListener('cancel', () => { resolve({ files: [] }); input.remove(); }, { once: true });
    document.body.append(input);
    input.click();
  });
}

// Dropped files (onto the conversation) and pasted images (into the
// composer) take the same path as the Attach button: describe, then the
// Rust side uploads. `send` receives each described batch.
export function carriesFiles(transfer) {
  return [...(transfer?.types ?? [])].includes('Files');
}

// A paste attaches files only when it carries no text, so pasting text from
// apps that also put a picture on the clipboard still pastes the text.
export function pastedFiles(clipboard) {
  const types = [...(clipboard?.types ?? [])];
  if (types.includes('text/plain')) return [];
  return [...(clipboard?.files ?? [])];
}

export function installDropZone(zone, textarea, send) {
  let depth = 0;
  const highlight = on => zone.classList.toggle('drop-active', on);
  const enter = event => { if (!carriesFiles(event.dataTransfer)) return; event.preventDefault(); depth += 1; highlight(true); };
  const over = event => { if (!carriesFiles(event.dataTransfer)) return; event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; };
  const leave = event => { if (!carriesFiles(event.dataTransfer)) return; depth = Math.max(0, depth - 1); if (!depth) highlight(false); };
  const drop = async event => {
    if (!carriesFiles(event.dataTransfer)) return;
    event.preventDefault(); depth = 0; highlight(false);
    send(await describe(event.dataTransfer.files));
  };
  const paste = async event => {
    const files = pastedFiles(event.clipboardData);
    if (!files.length) return;
    event.preventDefault();
    send(await describe(files));
  };
  // Files dropped elsewhere on the page must not replace the app with the file.
  const guard = event => { if (carriesFiles(event.dataTransfer) && !zone.contains(event.target)) { event.preventDefault(); if (event.type === 'dragover') event.dataTransfer.dropEffect = 'none'; } };
  const doc = zone.ownerDocument;
  zone.addEventListener('dragenter', enter); zone.addEventListener('dragover', over);
  zone.addEventListener('dragleave', leave); zone.addEventListener('drop', drop);
  textarea?.addEventListener('paste', paste);
  doc.addEventListener('dragover', guard); doc.addEventListener('drop', guard);
  return () => {
    zone.removeEventListener('dragenter', enter); zone.removeEventListener('dragover', over);
    zone.removeEventListener('dragleave', leave); zone.removeEventListener('drop', drop);
    textarea?.removeEventListener('paste', paste);
    doc.removeEventListener('dragover', guard); doc.removeEventListener('drop', guard);
    highlight(false);
  };
}

// Finds the conversation pane around the composer tools with `id`.
export async function watchDrops(document, id, dioxus) {
  let tools = null;
  for (let i = 0; i < 200 && !(tools = document.getElementById(id)); i++) await new Promise(r => setTimeout(r, 25));
  if (!tools) return null;
  const form = tools.closest('form');
  const zone = tools.closest('.conversation-pane') ?? form;
  const off = installDropZone(zone, form?.querySelector('textarea'), batch => dioxus.send(batch));
  await dioxus.recv();
  off();
  return null;
}
