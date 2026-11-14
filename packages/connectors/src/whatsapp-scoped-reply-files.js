// Files an assistant attaches to a group reply. The relay sends each one from
// its plaintext outbound snapshot, which V1 stages under
// `<uploads>/<threadId>/artifacts/<sha256>-<name>`. The worker re-reads and
// re-hashes the bytes itself, so a request can only name a snapshot of the
// group's own thread whose content still matches the digest V1 recorded.
//
// Every file type goes to WhatsApp (ORK-827). Photos, videos and audio that
// WhatsApp shows inline, up to its 16 MB media limit, go as media; every other
// file, and any larger one, goes as a document under its original name, with
// its real type or application/octet-stream. WhatsApp delivers documents of
// any type, so no extension is refused here.
//
// Size: whatsapp-web.js sets no limit of its own. It hands the file to the
// WhatsApp Web page as one base64 string, so a send holds about five copies
// in the worker and the browser. 64 MB keeps that and the 120 s send timeout
// comfortable; a larger file is named in the chat as "over 64 MB" instead.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const SCOPED_FILE_MAX_BYTES = 64 * 1024 * 1024;
export const SCOPED_FILE_MAX_LABEL = `over ${SCOPED_FILE_MAX_BYTES / (1024 * 1024)} MB`;
export const SCOPED_FILE_FALLBACK_MIMETYPE = 'application/octet-stream';
// WhatsApp's limit for photos, videos and audio sent as media.
export const SCOPED_INLINE_MEDIA_MAX_BYTES = 16 * 1024 * 1024;
// Types WhatsApp plays or shows inline, and the message type it records.
const INLINE_MEDIA = new Map([
  ['image/jpeg', 'image'], ['image/png', 'image'], ['image/webp', 'image'],
  ['video/mp4', 'video'], ['video/3gpp', 'video'],
  ['audio/mpeg', 'audio'], ['audio/mp4', 'audio'], ['audio/aac', 'audio'], ['audio/ogg', 'audio'], ['audio/amr', 'audio'],
]);
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;
const FILE_KEYS = ['path', 'filename', 'mimetype', 'sha256'];
const FILENAME = /^[^/\\\0\r\n]{1,180}$/;
const THREAD_ID = /^[A-Za-z0-9_-]{1,100}$/;

// The lowercase base type ("text/html; charset=utf-8" -> "text/html"), or
// application/octet-stream when there is none or it is malformed.
export function scopedFileMimetype(value) {
  const base = String(value ?? '').split(';')[0].trim().toLowerCase();
  return MEDIA_TYPE.test(base) ? base : SCOPED_FILE_FALLBACK_MIMETYPE;
}

// How WhatsApp gets the file: 'image', 'video' or 'audio' as inline media,
// otherwise 'document'. `size` is the byte length.
export function scopedFileSendKind({mimetype, size} = {}) {
  const kind = INLINE_MEDIA.get(mimetype);
  return kind && Number.isSafeInteger(size) && size > 0 && size <= SCOPED_INLINE_MEDIA_MAX_BYTES ? kind : 'document';
}

export const isReplyFile = entry => Boolean(entry && typeof entry === 'object' && entry.file);

// Shape only; no file system access. The type must be in canonical form
// (scopedFileMimetype): any type, never a malformed one.
export function validReplyFileShape(file) {
  return Boolean(file && typeof file === 'object' && !Array.isArray(file)
    && Object.keys(file).every(key => FILE_KEYS.includes(key))
    && typeof file.path === 'string' && path.isAbsolute(file.path)
    && typeof file.filename === 'string' && FILENAME.test(file.filename) && !file.filename.startsWith('.')
    && typeof file.mimetype === 'string' && MEDIA_TYPE.test(file.mimetype)
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
