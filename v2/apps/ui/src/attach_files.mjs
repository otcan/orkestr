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
    if (!file.size) return { error: `${safeName(file.name)} is empty.` };
    const bytes = new Uint8Array(await file.arrayBuffer());
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
