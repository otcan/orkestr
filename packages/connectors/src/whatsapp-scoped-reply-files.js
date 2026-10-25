// Files an assistant attaches to a group reply (PDF, spreadsheet, image…). The
// relay sends each one from its plaintext outbound snapshot, which V1 stages
// under `<uploads>/<threadId>/artifacts/<sha256>-<name>`. The worker re-reads
// and re-hashes the bytes itself, so a request can only name a snapshot of the
// group's own thread whose content still matches the digest V1 recorded.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const SCOPED_FILE_MAX_BYTES = 16 * 1024 * 1024;
export const SCOPED_FILE_MIMETYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/csv',
  'text/plain',
  'text/markdown',
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/zip',
]);
const FILE_KEYS = ['path', 'filename', 'mimetype', 'sha256'];
const FILENAME = /^[^/\\\0\r\n]{1,180}$/;
const THREAD_ID = /^[A-Za-z0-9_-]{1,100}$/;

export const isReplyFile = entry => Boolean(entry && typeof entry === 'object' && entry.file);

// Shape only; no file system access.
export function validReplyFileShape(file) {
  return Boolean(file && typeof file === 'object' && !Array.isArray(file)
    && Object.keys(file).every(key => FILE_KEYS.includes(key))
    && typeof file.path === 'string' && path.isAbsolute(file.path)
    && typeof file.filename === 'string' && FILENAME.test(file.filename) && !file.filename.startsWith('.')
    && SCOPED_FILE_MIMETYPES.has(file.mimetype)
    && typeof file.sha256 === 'string' && /^[0-9a-f]{64}$/.test(file.sha256));
}

// The canonical journal payload: what was sent, never where it was read from.
export function encodeReplyFile(file) {
  return JSON.stringify({file: {filename: file.filename, mimetype: file.mimetype, sha256: file.sha256}});
}

// Reads the snapshot bytes, or throws `reply_file_denied`.
export function readReplyFile(file, {root, threadId}) {
  const deny = () => { throw Object.assign(new Error('reply_file_denied'), {statusCode: 403}); };
  if (!validReplyFileShape(file) || typeof root !== 'string' || !path.isAbsolute(root) || !THREAD_ID.test(threadId || '')) deny();
  let realRoot, real;
  try {
    realRoot = fs.realpathSync(root);
    real = fs.realpathSync(file.path);
  } catch { deny(); }
  const directory = path.join(realRoot, threadId, 'artifacts');
  if (path.dirname(real) !== directory || !path.basename(real).startsWith(`${file.sha256}-`)) deny();
  const stat = fs.lstatSync(real);
  if (!stat.isFile() || stat.size < 1 || stat.size > SCOPED_FILE_MAX_BYTES) deny();
  const data = fs.readFileSync(real);
  if (data.length !== stat.size || crypto.createHash('sha256').update(data).digest('hex') !== file.sha256) deny();
  return data;
}
