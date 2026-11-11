// File operations inside ONE granted folder (File System Access API).
// Every path is resolved from the granted directory handle one name at a
// time with getDirectoryHandle/getFileHandle, so nothing outside the folder
// can be named. Empty names, '.', '..', a leading or trailing '/', backslashes
// and control characters are refused before the browser is asked.
const MiB = 1024 * 1024;
// Must equal the server's LOCAL_FILE_* limits (crates/contracts/src/local_files.rs).
export const LIMITS = Object.freeze({pathMax:1024,nameMax:255,depthMax:32,listMax:1000,pathsMax:64,
  writeMax:MiB,readMax:64*MiB,packageMax:64*MiB,hashMax:128*MiB});

export class FolderError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new FolderError(code); };
const utf8 = value => new TextEncoder().encode(value);
const hex = bytes => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
export const sha256 = async (bytes, subtle = crypto.subtle) => hex(await subtle.digest('SHA-256', bytes));

/** Names of a path relative to the folder; [] is the folder itself. */
export function splitPath(path, {root = false} = {}) {
  if (typeof path !== 'string') fail('invalid_path');
  if (path === '') return root ? [] : fail('invalid_path');
  if (utf8(path).length > LIMITS.pathMax || path.includes('\\') || /[\u0000-\u001f\u007f-\u009f]/.test(path)) fail('invalid_path');
  const parts = path.split('/');
  if (parts.length > LIMITS.depthMax || parts.some(p => !p || p === '.' || p === '..' || utf8(p).length > LIMITS.nameMax)) fail('invalid_path');
  return parts;
}

// Browser DOMException names to the server's closed error codes.
function mapped(error, expected) {
  if (error instanceof FolderError) return error;
  switch (error?.name) {
    case 'NotFoundError': return new FolderError('not_found');
    case 'TypeMismatchError': return new FolderError(expected === 'file' ? 'not_a_file' : 'not_a_directory');
    case 'NotAllowedError': case 'SecurityError': return new FolderError('permission_denied');
    case 'NotReadableError': case 'InvalidStateError': case 'NoModificationAllowedError': return new FolderError('changed');
    case 'TypeError': return new FolderError('invalid_path');
    default: return new FolderError('browser_error');
  }
}
async function directoryAt(root, parts) {
  let directory = root;
  for (const part of parts) {
    try { directory = await directory.getDirectoryHandle(part); }
    catch (error) { throw mapped(error, 'directory'); }
  }
  return directory;
}
async function fileHandle(root, path) {
  const parts = splitPath(path);
  const directory = await directoryAt(root, parts.slice(0, -1));
  try { return await directory.getFileHandle(parts.at(-1)); }
  catch (error) { throw mapped(error, 'file'); }
}

/** One directory, not recursive; names the server could not name are left out. */
export async function listFolder(root, path) {
  const directory = await directoryAt(root, splitPath(path, {root: true}));
  const entries = [];
  let truncated = false;
  const nameable = name => { try { return splitPath(name).length === 1; } catch { return false; } };
  try {
    for await (const [name, handle] of directory.entries()) {
      if (!nameable(name)) continue;
      if (entries.length >= LIMITS.listMax) { truncated = true; break; }
      const entry = {name, kind: handle.kind === 'directory' ? 'directory' : 'file'};
      if (entry.kind === 'file') {
        try { const file = await handle.getFile(); entry.size = file.size; entry.last_modified_ms = file.lastModified; }
        catch { /* Size and time are optional in a listing. */ }
      }
      entries.push(entry);
    }
  } catch (error) { throw mapped(error, 'directory'); }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {entries, truncated};
}

/** A snapshot File of one file, refused above `max` bytes. */
export async function readFile(root, path, max = LIMITS.readMax) {
  const handle = await fileHandle(root, path);
  let file;
  try { file = await handle.getFile(); }
  catch (error) { throw mapped(error, 'file'); }
  if (file.size > max) fail('too_large');
  return file;
}

export async function hashFiles(root, paths, subtle = crypto.subtle) {
  if (!Array.isArray(paths) || !paths.length || paths.length > LIMITS.pathsMax) fail('invalid_path');
  const files = [];
  for (const path of paths) {
    const file = await readFile(root, path, LIMITS.hashMax);
    let bytes;
    try { bytes = await file.arrayBuffer(); }
    catch (error) { throw mapped(error, 'file'); }
    files.push({path, size: file.size, sha256: await sha256(bytes, subtle)});
  }
  return {files};
}

/** Create or replace one file in an existing folder of the grant. The caller
 * must already hold readwrite permission (asked for in the owner's click). */
export async function writeFile(root, path, bytes, subtle = crypto.subtle) {
  if (!(bytes instanceof Uint8Array) || bytes.length > LIMITS.writeMax) fail('too_large');
  const parts = splitPath(path);
  const directory = await directoryAt(root, parts.slice(0, -1));
  let handle, created = false;
  try { handle = await directory.getFileHandle(parts.at(-1)); }
  catch (error) {
    if (error?.name !== 'NotFoundError') throw mapped(error, 'file');
    created = true;
    try { handle = await directory.getFileHandle(parts.at(-1), {create: true}); }
    catch (again) { throw mapped(again, 'file'); }
  }
  let writable;
  try {
    writable = await handle.createWritable({keepExistingData: false});
    await writable.write(bytes);
    await writable.close();
  } catch (error) {
    await writable?.abort?.().catch?.(() => {});
    throw mapped(error, 'file');
  }
  return {bytes_written: bytes.length, sha256: await sha256(bytes, subtle), created};
}

/** Must equal the server's package_name(): the archive the tab uploads. */
export const packageName = requestId => `selection-${String(requestId).replaceAll('-', '').slice(0, 12)}.tar`;

// One ustar header. Paths over 100 bytes are split at a '/' into the
// 155-byte prefix and the 100-byte name; others cannot be packaged.
function tarHeader(path, size, modifiedMs) {
  const bytes = utf8(path);
  let name = bytes, prefix = new Uint8Array(0);
  if (bytes.length > 100) {
    let cut = -1;
    for (let i = Math.min(155, bytes.length - 1); i > 0; i--) {
      if (bytes[i] === 0x2f) { if (bytes.length - i - 1 <= 100) cut = i; break; }
    }
    if (cut < 0) fail('invalid_path');
    prefix = bytes.subarray(0, cut); name = bytes.subarray(cut + 1);
  }
  const header = new Uint8Array(512);
  const octal = (value, width) => utf8(Math.max(0, Math.floor(value)).toString(8).padStart(width - 1, '0') + '\0');
  header.set(name, 0);
  header.set(octal(0o644, 8), 100); header.set(octal(0, 8), 108); header.set(octal(0, 8), 116);
  header.set(octal(size, 12), 124); header.set(octal(modifiedMs / 1000, 12), 136);
  header.fill(0x20, 148, 156); header[156] = 0x30;
  header.set(utf8('ustar\0'), 257); header.set(utf8('00'), 263); header.set(prefix, 345);
  const sum = header.reduce((total, b) => total + b, 0);
  header.set(utf8(sum.toString(8).padStart(6, '0') + '\0 '), 148);
  return header;
}

/** An uncompressed tar of the selection, composed from File parts: no file
 * is read into memory here; the upload reads it in bounded chunks. */
export async function packageFiles(root, paths, name) {
  if (!Array.isArray(paths) || !paths.length || paths.length > LIMITS.pathsMax) fail('invalid_path');
  const parts = [], files = [];
  let total = 1024;
  for (const path of paths) {
    const file = await readFile(root, path, LIMITS.packageMax);
    total += 512 + Math.ceil(file.size / 512) * 512;
    if (total > LIMITS.packageMax) fail('too_large');
    parts.push(tarHeader(path, file.size, file.lastModified), file);
    const pad = (512 - (file.size % 512)) % 512;
    if (pad) parts.push(new Uint8Array(pad));
    files.push({path, size: file.size});
  }
  parts.push(new Uint8Array(1024));
  return {file: new File(parts, name, {type: 'application/x-tar'}), files};
}
