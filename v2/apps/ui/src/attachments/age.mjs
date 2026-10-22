// Browser half of attachment encryption: the V1 protocol and the age file
// format (X25519 recipients, ChaCha20-Poly1305 payload). The private
// identity stays in this browser, under the same storage key the V1 app used
// on this origin, so a browser enrolled there keeps reading its attachments.
// Only the public `age1...` recipient and challenge proofs reach the server.
// WebCrypto supplies X25519, HKDF, HMAC and SHA-256; ChaCha20-Poly1305 is
// implemented below because WebCrypto has no ChaCha cipher.
export const AGE_IDENTITY_KEY = 'orkestr.attachment-age-identity.v1';
export const AGE_KEYS_PATH = '/api/v2/attachment-keys';
const AGE_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const AGE_INTRO = 'age-encryption.org/v1\n';
const AGE_CHUNK = 65536;
const AGE_PAYLOAD_MAGIC = 'ORKESTR-ATTACHMENT-PAYLOAD/1';
const AGE_PKCS8_X25519 = [0x30,0x2e,0x02,0x01,0x00,0x30,0x05,0x06,0x03,0x2b,0x65,0x6e,0x04,0x22,0x04,0x20];
const ageText = new TextEncoder();
const ageFail = reason => { throw new Error(`attachment_${reason}`); };

function ageConcat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

// --- bech32 (age keys) ---
function agePolymod(values) {
  const g = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]; let chk = 1;
  for (const v of values) { const top = chk >>> 25; chk = ((chk & 0x1ffffff) << 5) ^ v; for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= g[i]; }
  return chk >>> 0;
}
function ageHrp(hrp) { return [...[...hrp].map(c => c.charCodeAt(0) >> 5), 0, ...[...hrp].map(c => c.charCodeAt(0) & 31)]; }
function ageRegroup(data, from, to, pad) {
  let acc = 0, bits = 0; const out = [], max = (1 << to) - 1;
  for (const v of data) { acc = ((acc << from) | v) & 0xffff; bits += from; while (bits >= to) { bits -= to; out.push((acc >> bits) & max); } }
  if (pad) { if (bits) out.push((acc << (to - bits)) & max); }
  else if (bits >= from || ((acc << (to - bits)) & max)) ageFail('key_invalid');
  return out;
}
export function ageBech32Encode(hrp, bytes) {
  const data = ageRegroup(bytes, 8, 5, true);
  const mod = agePolymod([...ageHrp(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  const check = [0, 1, 2, 3, 4, 5].map(i => (mod >>> (5 * (5 - i))) & 31);
  return `${hrp}1${[...data, ...check].map(v => AGE_CHARSET[v]).join('')}`;
}
export function ageBech32Decode(text) {
  const value = String(text || '').trim(); const lower = value.toLowerCase();
  if (value !== lower && value !== value.toUpperCase()) ageFail('key_invalid');
  const split = lower.lastIndexOf('1');
  if (split < 1 || split + 7 > lower.length) ageFail('key_invalid');
  const hrp = lower.slice(0, split);
  const data = [...lower.slice(split + 1)].map(c => { const v = AGE_CHARSET.indexOf(c); if (v < 0) ageFail('key_invalid'); return v; });
  if (agePolymod([...ageHrp(hrp), ...data]) !== 1) ageFail('key_invalid');
  return { hrp, bytes: Uint8Array.from(ageRegroup(data.slice(0, -6), 5, 8, false)) };
}

// --- canonical unpadded base64 (age header) and padded base64 (JSON) ---
const AGE_B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export function ageBase64Decode(text, padded = false) {
  let value = String(text);
  if (padded) value = value.replace(/={0,2}$/, '');
  if (/[^A-Za-z0-9+/]/.test(value) || value.length % 4 === 1) ageFail('base64_invalid');
  const out = new Uint8Array(Math.floor(value.length * 3 / 4)); let acc = 0, bits = 0, at = 0;
  for (const c of value) { acc = (acc << 6) | AGE_B64.indexOf(c); bits += 6; if (bits >= 8) { bits -= 8; out[at++] = (acc >> bits) & 255; } acc &= (1 << bits) - 1; }
  if (acc !== 0) ageFail('base64_invalid'); // non-canonical trailing bits
  return out;
}

// --- ChaCha20-Poly1305 (RFC 8439) ---
function ageWords(bytes, n) { const w = new Uint32Array(n); for (let i = 0; i < n; i++) w[i] = bytes[4 * i] | bytes[4 * i + 1] << 8 | bytes[4 * i + 2] << 16 | bytes[4 * i + 3] << 24; return w; }
function ageChachaBlock(key, counter, nonce, out) {
  const s = new Uint32Array(16); s[0] = 0x61707865; s[1] = 0x3320646e; s[2] = 0x79622d32; s[3] = 0x6b206574;
  s.set(key, 4); s[12] = counter; s.set(nonce, 13); const x = s.slice();
  const qr = (a, b, c, d) => {
    x[a] += x[b]; x[d] ^= x[a]; x[d] = x[d] << 16 | x[d] >>> 16;
    x[c] += x[d]; x[b] ^= x[c]; x[b] = x[b] << 12 | x[b] >>> 20;
    x[a] += x[b]; x[d] ^= x[a]; x[d] = x[d] << 8 | x[d] >>> 24;
    x[c] += x[d]; x[b] ^= x[c]; x[b] = x[b] << 7 | x[b] >>> 25;
  };
  for (let i = 0; i < 10; i++) { qr(0, 4, 8, 12); qr(1, 5, 9, 13); qr(2, 6, 10, 14); qr(3, 7, 11, 15); qr(0, 5, 10, 15); qr(1, 6, 11, 12); qr(2, 7, 8, 13); qr(3, 4, 9, 14); }
  for (let i = 0; i < 16; i++) out[i] = x[i] + s[i];
}
function ageChachaXor(key, nonce, counter, input) {
  const k = ageWords(key, 8), n = ageWords(nonce, 3), block = new Uint32Array(16), out = new Uint8Array(input.length);
  for (let at = 0; at < input.length; at += 64, counter++) {
    ageChachaBlock(k, counter >>> 0, n, block);
    const end = Math.min(64, input.length - at);
    for (let i = 0; i < end; i++) out[at + i] = input[at + i] ^ ((block[i >> 2] >>> ((i & 3) * 8)) & 255);
  }
  return out;
}
const AGE_P = (1n << 130n) - 5n, AGE_M130 = (1n << 130n) - 1n, AGE_M128 = (1n << 128n) - 1n;
function ageLittle(bytes) { let v = 0n; for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]); return v; }
export function agePoly1305(key, message) {
  const r = ageLittle(key.subarray(0, 16)) & 0x0ffffffc0ffffffc0ffffffc0fffffffn, s = ageLittle(key.subarray(16, 32));
  const view = new DataView(message.buffer, message.byteOffset, message.byteLength); let h = 0n;
  for (let i = 0; i < message.length; i += 16) {
    const n = i + 16 <= message.length
      ? view.getBigUint64(i, true) | view.getBigUint64(i + 8, true) << 64n | 1n << 128n
      : ageLittle(message.subarray(i)) | 1n << BigInt(8 * (message.length - i));
    h = (h + n) * r; h = (h & AGE_M130) + (h >> 130n) * 5n;
  }
  h = (h & AGE_M130) + (h >> 130n) * 5n; while (h >= AGE_P) h -= AGE_P;
  const tag = (h + s) & AGE_M128, out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = Number((tag >> BigInt(8 * i)) & 255n);
  return out;
}
export function ageAeadOpen(key, nonce, sealed) {
  if (sealed.length < 16) ageFail('decryption_failed');
  const body = sealed.subarray(0, sealed.length - 16), tag = sealed.subarray(sealed.length - 16);
  const block = new Uint32Array(16); ageChachaBlock(ageWords(key, 8), 0, ageWords(nonce, 3), block);
  const polyKey = new Uint8Array(32); for (let i = 0; i < 32; i++) polyKey[i] = (block[i >> 2] >>> ((i & 3) * 8)) & 255;
  const padded = Math.ceil(body.length / 16) * 16, mac = new Uint8Array(padded + 16); mac.set(body);
  new DataView(mac.buffer).setBigUint64(padded + 8, BigInt(body.length), true);
  const expected = agePoly1305(polyKey, mac); let diff = 0;
  for (let i = 0; i < 16; i++) diff |= expected[i] ^ tag[i];
  if (diff) ageFail('decryption_failed');
  return ageChachaXor(key, nonce, 1, body);
}

// --- age X25519 identities and files ---
async function ageX25519(subtle, privateKey, publicBytes) {
  const key = await subtle.importKey('raw', publicBytes, { name: 'X25519' }, false, []);
  return new Uint8Array(await subtle.deriveBits({ name: 'X25519', public: key }, privateKey, 256));
}
async function ageHkdf(subtle, ikm, salt, info) {
  const key = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: ageText.encode(info) }, key, 256));
}
async function ageIdentity(subtle, identity) {
  const { hrp, bytes } = ageBech32Decode(identity);
  if (hrp !== 'age-secret-key-' || bytes.length !== 32) ageFail('identity_invalid');
  const key = await subtle.importKey('pkcs8', ageConcat(Uint8Array.from(AGE_PKCS8_X25519), bytes), { name: 'X25519' }, false, ['deriveBits']);
  const basepoint = new Uint8Array(32); basepoint[0] = 9;
  return { key, public: await ageX25519(subtle, key, basepoint) };
}
export function ageGenerateIdentity(random = bytes => crypto.getRandomValues(bytes)) {
  return ageBech32Encode('age-secret-key-', random(new Uint8Array(32))).toUpperCase();
}
export async function ageIdentityToRecipient(identity, subtle = crypto.subtle) {
  return ageBech32Encode('age', (await ageIdentity(subtle, identity)).public);
}
export async function ageFingerprint(recipient, subtle = crypto.subtle) {
  const digest = new Uint8Array(await subtle.digest('SHA-256', ageText.encode(recipient)));
  return `SHA256:${[...digest].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32)}`;
}
function ageLine(file, at) {
  const end = file.indexOf(10, at); if (end < 0 || end - at > 1024) ageFail('format_invalid');
  return { line: String.fromCharCode(...file.subarray(at, end)), next: end + 1 };
}
export async function ageDecrypt(identity, file, subtle = crypto.subtle) {
  file = file instanceof Uint8Array ? file : new Uint8Array(file);
  if (String.fromCharCode(...file.subarray(0, AGE_INTRO.length)) !== AGE_INTRO) ageFail('format_invalid');
  let at = AGE_INTRO.length, mac = null, headerEnd = 0; const stanzas = [];
  while (mac === null) {
    const { line, next } = ageLine(file, at);
    if (line.startsWith('--- ')) { mac = ageBase64Decode(line.slice(4)); headerEnd = at + 3; at = next; break; }
    if (!line.startsWith('-> ') || stanzas.length > 256) ageFail('format_invalid');
    at = next; let body = '';
    for (;;) { const part = ageLine(file, at); at = part.next; if (part.line.length > 64) ageFail('format_invalid'); body += part.line; if (part.line.length < 64) break; }
    stanzas.push({ args: line.slice(3).split(' '), body: ageBase64Decode(body) });
  }
  const own = await ageIdentity(subtle, identity); let fileKey = null;
  for (const { args, body } of stanzas) {
    if (args[0] !== 'X25519') continue;
    if (args.length !== 2 || body.length !== 32) ageFail('format_invalid');
    const share = ageBase64Decode(args[1]); if (share.length !== 32) ageFail('format_invalid');
    let shared; try { shared = await ageX25519(subtle, own.key, share); } catch { continue; }
    if (shared.every(b => b === 0)) continue;
    const wrap = await ageHkdf(subtle, shared, ageConcat(share, own.public), 'age-encryption.org/v1/X25519');
    try { fileKey = ageAeadOpen(wrap, new Uint8Array(12), body); break; } catch { /* another recipient */ }
  }
  if (!fileKey) ageFail('identity_not_recipient');
  const hmac = await subtle.importKey('raw', await ageHkdf(subtle, fileKey, new Uint8Array(0), 'header'), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  if (!await subtle.verify('HMAC', hmac, mac, file.subarray(0, headerEnd))) ageFail('decryption_failed');
  const nonce = file.subarray(at, at + 16); if (nonce.length !== 16) ageFail('format_invalid');
  const payloadKey = await ageHkdf(subtle, fileKey, nonce, 'payload');
  const data = file.subarray(at + 16), pieces = []; let offset = 0, counter = 0;
  if (!data.length) ageFail('format_invalid');
  for (;;) {
    const remaining = data.length - offset, last = remaining <= AGE_CHUNK + 16, size = Math.min(remaining, AGE_CHUNK + 16);
    const chunkNonce = new Uint8Array(12); let c = counter;
    for (let i = 10; i >= 0; i--) { chunkNonce[i] = c & 255; c = Math.floor(c / 256); }
    chunkNonce[11] = last ? 1 : 0;
    const plain = ageAeadOpen(payloadKey, chunkNonce, data.subarray(offset, offset + size));
    if (last && !plain.length && counter > 0) ageFail('format_invalid');
    pieces.push(plain); offset += size; counter++;
    if (last) break;
  }
  return ageConcat(...pieces);
}

// --- V1 payload framing inside the age plaintext ---
export async function ageDecodePayload(bytes, subtle = crypto.subtle) {
  const first = bytes.indexOf(10), second = first < 0 ? -1 : bytes.indexOf(10, first + 1);
  if (second < 0) ageFail('payload_invalid');
  const text = new TextDecoder('utf-8', { fatal: true });
  if (text.decode(bytes.subarray(0, first)) !== AGE_PAYLOAD_MAGIC) ageFail('payload_format_unsupported');
  const lengthText = text.decode(bytes.subarray(first + 1, second));
  if (!/^[1-9][0-9]{0,5}$/.test(lengthText)) ageFail('payload_header_invalid');
  const start = second + 1, end = start + Number(lengthText);
  if (end > bytes.length) ageFail('payload_header_invalid');
  let meta; try { meta = JSON.parse(text.decode(bytes.subarray(start, end))); } catch { ageFail('payload_metadata_invalid'); }
  if (!meta || meta.version !== 1) ageFail('payload_metadata_invalid');
  const content = bytes.slice(end);
  if (meta.plaintextSize !== content.length) ageFail('payload_size_mismatch');
  const digest = [...new Uint8Array(await subtle.digest('SHA-256', content))].map(b => b.toString(16).padStart(2, '0')).join('');
  if (digest !== String(meta.plaintextChecksum)) ageFail('payload_checksum_mismatch');
  return { filename: String(meta.filename || ''), mimetype: String(meta.mimetype || ''), bytes: content };
}

function ageStoredIdentity(storage) { try { const v = String(storage?.getItem(AGE_IDENTITY_KEY) || '').trim(); return v.startsWith('AGE-SECRET-KEY-1') ? v : ''; } catch { return ''; } }

// Decrypts a sealed attachment with this browser's identity: V1 payload bytes.
export async function ageOpenSealed(ciphertext, { storage = globalThis.localStorage, subtle = crypto.subtle } = {}) {
  const identity = ageStoredIdentity(storage);
  if (!identity) throw new Error('This browser has no attachment key yet. Reload the app to enroll it.');
  try { return await ageDecrypt(identity, ciphertext, subtle); }
  catch (error) {
    if (error.message === 'attachment_identity_not_recipient') throw new Error('This file was encrypted before this browser was enrolled; open it in a browser enrolled at that time.');
    throw new Error('File decryption failed');
  }
}

// V1 automatic enrollment: keep (or create) this browser's identity, register
// its recipient, answer the possession challenge, then require encryption.
export async function ageEnsureEnrollment({ csrf, fetcher = fetch, storage = globalThis.localStorage, subtle = crypto.subtle, random } = {}) {
  const call = async (method, path, body) => {
    const response = await fetcher(path, { method, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'x-orkestr-csrf': csrf }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const value = await response.json().catch(() => ({}));
    if (response.status !== 200) { const error = new Error(value.message || `attachment key request failed (${response.status})`); error.status = response.status; throw error; }
    return value;
  };
  let identity = ageStoredIdentity(storage), recipient = '';
  if (identity) { try { recipient = await ageIdentityToRecipient(identity, subtle); } catch { identity = ''; } }
  if (!identity) {
    identity = ageGenerateIdentity(random); recipient = await ageIdentityToRecipient(identity, subtle);
    try { storage?.setItem(AGE_IDENTITY_KEY, identity); } catch { /* kept for this page only */ }
  }
  const fingerprint = await ageFingerprint(recipient, subtle);
  let status = await call('GET', AGE_KEYS_PATH);
  if (!status.keys?.some(k => k.fingerprint === fingerprint && k.status === 'active')) {
    const key = await call('POST', AGE_KEYS_PATH, { recipient, label: 'Automatic WebUI browser' });
    if (key.status === 'pending_verification') {
      if (!key.challenge?.ciphertext_base64) ageFail('challenge_missing');
      const proof = new TextDecoder().decode(await ageDecrypt(identity, ageBase64Decode(key.challenge.ciphertext_base64, true), subtle));
      await call('POST', `${AGE_KEYS_PATH}/${key.id}/verify`, { proof });
    } else if (key.status !== 'active') ageFail('recipient_not_active');
    status = await call('GET', AGE_KEYS_PATH);
  }
  if (!status.required) status = await call('POST', `${AGE_KEYS_PATH}/policy`, { required: true });
  return { fingerprint, required: status.required, ready: status.ready };
}
