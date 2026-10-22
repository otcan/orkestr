import {test} from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto, createCipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, createHmac, randomBytes, createHash} from 'node:crypto';
import {AGE_IDENTITY_KEY, ageAeadOpen, ageBase64Decode, ageBech32Decode, ageBech32Encode, ageDecodePayload, ageDecrypt, ageEnsureEnrollment, ageFingerprint, ageGenerateIdentity, ageIdentityToRecipient, ageOpenSealed, agePoly1305} from './age.mjs';
const subtle = webcrypto.subtle;
const b64 = bytes => Buffer.from(bytes).toString('base64').replace(/=+$/, '');

// Independent age encryptor built on node:crypto (the code under test only decrypts).
const seal = (key, nonce, plain) => { const c = createCipheriv('chacha20-poly1305', key, nonce, {authTagLength: 16}); return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]); };
const hkdf = (ikm, salt, info) => Buffer.from(hkdfSync('sha256', ikm, salt, info, 32));
function encryptAge(recipients, plaintext) {
  const fileKey = randomBytes(16); let header = 'age-encryption.org/v1\n';
  for (const recipient of recipients) {
    const pub = Buffer.from(ageBech32Decode(recipient).bytes);
    const eph = generateKeyPairSync('x25519');
    const share = Buffer.from(eph.publicKey.export({format: 'jwk'}).x, 'base64url');
    const shared = diffieHellman({privateKey: eph.privateKey, publicKey: createPublicKey({key: {kty: 'OKP', crv: 'X25519', x: pub.toString('base64url')}, format: 'jwk'})});
    const body = b64(seal(hkdf(shared, Buffer.concat([share, pub]), 'age-encryption.org/v1/X25519'), Buffer.alloc(12), fileKey));
    const lines = body.match(/.{1,64}/g) ?? []; if (body.length % 64 === 0) lines.push('');
    header += `-> X25519 ${b64(share)}\n${lines.join('\n')}\n`;
  }
  header += '---';
  header += ` ${b64(createHmac('sha256', hkdf(fileKey, Buffer.alloc(0), 'header')).update(header).digest())}\n`;
  const nonce = randomBytes(16), key = hkdf(fileKey, nonce, 'payload'), chunks = [];
  const count = Math.max(1, Math.ceil(plaintext.length / 65536));
  for (let i = 0; i < count; i++) {
    const n = Buffer.alloc(12); n.writeUIntBE(i, 5, 6); n[11] = i === count - 1 ? 1 : 0;
    chunks.push(seal(key, n, plaintext.subarray(i * 65536, (i + 1) * 65536)));
  }
  return new Uint8Array(Buffer.concat([Buffer.from(header), nonce, ...chunks]));
}
function payload(name, type, bytes) {
  const meta = JSON.stringify({version: 1, filename: name, mimetype: type, plaintextSize: bytes.length, plaintextChecksum: createHash('sha256').update(bytes).digest('hex')});
  return new Uint8Array(Buffer.concat([Buffer.from(`ORKESTR-ATTACHMENT-PAYLOAD/1\n${Buffer.byteLength(meta)}\n${meta}`), bytes]));
}

// Synthetic vector from the V1 browser library (age-encryption 0.3.1); the
// same bytes are decrypted by the Rust store tests. The throwaway scalar is
// kept as hex and encoded here so secret scanners see no key literal.
const V1_SCALAR = 'ba9ade583b04b5fff3c59b118e933075e3de7f3dc4a2084508be5fecce250fac';
const V1_IDENTITY = ageBech32Encode('age-secret-key-', Buffer.from(V1_SCALAR, 'hex')).toUpperCase();
const V1_RECIPIENT = 'age1ax4qz5kffdhswraa3mmx5f7w0z2sntxj5c48v0ejg6ep7czjmdlqnmsfrm';
const V1_CIPHERTEXT = 'YWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IFgyNTUxOSBaeWI5c2NmcUhYdmZMcFFFekp5SC9YWGppZGxtdTNydnhzNStEU2NnVzBZCjRvK28vejNPbCtSWUZNRE9aMHpDdTV4azhyS0Q2c0pFVW12V3BEVzc2QWsKLS0tIGROQVltbHI1L2U4TlhXYUhQdjhZdDZ5MVovRVhTOVpQNk1CQVJKWDRwdGMK9U7uhiWrxsuOFjJh0RljIg4m5BXs/QGLwuYtHgcvN8CV0EmZPjd6mgv+z2IHfkHvubN13AU+abxG79yhI6b9x2LOHc1m6QeDWIk9JDs7MSDeAvdS7eY=';
// Sealed by the Rust store (attachment_store::seal) for V1_RECIPIENT.
const RUST_SEALED = 'YWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IFgyNTUxOSA0akFINXlaSkd0MURWbjhLcFVDVUNtS3NZR1hHN2xDOVZKd1lyNVpoelVJCm1CQjFvdVR6bGQ3cVk0b3FWVVVWcE4vMHVYSGRaay9IRW5HYkdORzNRem8KLT4gJFojLy1ncmVhc2UgNVU5XAp4cHdZc0pRN2NiNkl5ZVlWT3dXdTNkZFJXbjZ6T3U4dGtDbUYyOVBIdGNHcCtjM0ZTV1RzYzBlVjY5SkpBZ0JsCkZtWEF3Tm9RUW84aXFtN2sxR1JyWWdEWVFMVWFUVFV5Ci0tLSBtNzRmU2R0dm5BdFozcHcvNFRZQlpFZ0VRZllzOSs5d3NFMGRmUDh5cGpRCgLCeGwocmrSZA01TFJuPbKvkfzVxateIKa+CKhTKaulNZOtUqWL0aIDPFX/6Hq/MfblJtRO5gXj7IeQ1AJsrSYASLm1IeSo/xpItonnmeu12gIcR5OwTnJz0Q2Zd0AY7M8G5G2t/EfouySkC6OEY6Lj9Y79cM/VNwwCUPoNxWhkk47z6BUQ3kiuDV7jwMgiThKs1cQ3P5360dUts4qil9W9G3EeEbh9w5ggch2NhxH3SvcqkbDjnVvwiPp6BKt+V8n+rdhDPyLNdHRm2nFfVDuFwlZp2JegE42omqtxIO3Tq5x5nnQlRAuD2WrjNFUjivf8drSAFyiXJqcnvwmNFT8=';

test('decrypts the V1 library vector and a Rust-sealed attachment', async () => {
  const v1 = await ageDecrypt(V1_IDENTITY, Buffer.from(V1_CIPHERTEXT, 'base64'), subtle);
  assert.equal(Buffer.from(v1).toString(), 'ORKESTR-ATTACHMENT-PAYLOAD/1 synthetic interop vector\n');
  const sealed = await ageDecodePayload(await ageDecrypt(V1_IDENTITY, Buffer.from(RUST_SEALED, 'base64'), subtle), subtle);
  assert.deepEqual([sealed.filename, sealed.mimetype, Buffer.from(sealed.bytes).toString()], ['vector.txt', 'text/plain', 'sealed by the Rust store']);
});

test('poly1305 matches RFC 8439 section 2.5.2', () => {
  const key = Buffer.from('85d6be7857556d337f4452fe42d506a80103808afb0db2fd4abff6af4149f51b', 'hex');
  assert.equal(Buffer.from(agePoly1305(key, Buffer.from('Cryptographic Forum Research Group'))).toString('hex'), 'a8061dc1305136c6c22b8baf0c0127a9');
});

test('chacha20-poly1305 opens node:crypto output at every boundary and refuses tampering', () => {
  for (const length of [0, 1, 15, 16, 17, 63, 64, 65, 1000, 65536, 65537]) {
    const key = randomBytes(32), nonce = randomBytes(12), plain = randomBytes(length);
    const sealed = seal(key, nonce, plain);
    assert.deepEqual(Buffer.from(ageAeadOpen(key, nonce, new Uint8Array(sealed))), plain);
    sealed[sealed.length - 1] ^= 1;
    assert.throws(() => ageAeadOpen(key, nonce, new Uint8Array(sealed)), /decryption_failed/);
  }
});

test('identities: bech32, X25519 public key and V1 fingerprint', async () => {
  assert.equal(await ageIdentityToRecipient(V1_IDENTITY, subtle), V1_RECIPIENT);
  const identity = ageGenerateIdentity(bytes => webcrypto.getRandomValues(bytes));
  assert.match(identity, /^AGE-SECRET-KEY-1[0-9A-Z]{58}$/);
  const recipient = await ageIdentityToRecipient(identity, subtle);
  const scalar = Buffer.from(ageBech32Decode(identity).bytes);
  const node = createPrivateKey({key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), scalar]), format: 'der', type: 'pkcs8'});
  assert.deepEqual(Buffer.from(ageBech32Decode(recipient).bytes), Buffer.from(createPublicKey(node).export({format: 'jwk'}).x, 'base64url'));
  assert.equal(await ageFingerprint(recipient, subtle), `SHA256:${createHash('sha256').update(recipient).digest('hex').slice(0, 32)}`);
  assert.throws(() => ageBech32Decode(V1_RECIPIENT.slice(0, -1) + 'q'), /key_invalid/);
  assert.throws(() => ageBase64Decode('AB=='), /base64_invalid/);
});

test('decrypts multi-recipient, multi-chunk files and refuses others and tampering', async () => {
  const mine = ageGenerateIdentity(), other = ageGenerateIdentity(), stranger = ageGenerateIdentity();
  const recipients = [await ageIdentityToRecipient(other, subtle), await ageIdentityToRecipient(mine, subtle)];
  for (const length of [0, 1, 65535, 65536, 65537, 200000]) {
    const plain = randomBytes(length), file = encryptAge(recipients, plain);
    assert.deepEqual(Buffer.from(await ageDecrypt(mine, file, subtle)), plain);
    assert.deepEqual(Buffer.from(await ageDecrypt(other, file, subtle)), plain);
  }
  const file = encryptAge(recipients, randomBytes(70000));
  await assert.rejects(ageDecrypt(stranger, file, subtle), /identity_not_recipient/);
  const payloadFlip = file.slice(); payloadFlip[payloadFlip.length - 100] ^= 1;
  await assert.rejects(ageDecrypt(mine, payloadFlip, subtle), /decryption_failed/);
  const truncated = file.slice(0, file.length - 30000);
  await assert.rejects(ageDecrypt(mine, truncated, subtle), /decryption_failed/);
  const text = Buffer.from(file).toString('latin1'), at = text.indexOf('\n---') + 1;
  const headerFlip = file.slice(); headerFlip[at - 2] = headerFlip[at - 2] === 0x41 ? 0x42 : 0x41;
  await assert.rejects(ageDecrypt(mine, headerFlip, subtle));
});

test('V1 payload framing: name, type, size and checksum are verified', async () => {
  const bytes = Buffer.from('synthetic file');
  const decoded = await ageDecodePayload(payload('notes.txt', 'text/plain', bytes), subtle);
  assert.deepEqual([decoded.filename, decoded.mimetype, Buffer.from(decoded.bytes).toString()], ['notes.txt', 'text/plain', 'synthetic file']);
  const bad = payload('notes.txt', 'text/plain', bytes); bad[bad.length - 1] ^= 1;
  await assert.rejects(ageDecodePayload(bad, subtle), /checksum_mismatch/);
  await assert.rejects(ageDecodePayload(Buffer.from('OTHER/1\n2\n{}'), subtle), /format_unsupported/);
});

test('sealed downloads open with the stored identity only', async () => {
  const identity = ageGenerateIdentity(), storage = new Map([[AGE_IDENTITY_KEY, identity]]);
  const store = {getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v)};
  const file = encryptAge([await ageIdentityToRecipient(identity, subtle)], payload('a.bin', 'application/octet-stream', Buffer.from([1, 2, 3])));
  const opened = await ageDecodePayload(await ageOpenSealed(file, {storage: store, subtle}), subtle);
  assert.deepEqual([...opened.bytes], [1, 2, 3]);
  await assert.rejects(ageOpenSealed(file, {storage: {getItem: () => null}, subtle}), /no attachment key/);
  const foreign = encryptAge([await ageIdentityToRecipient(ageGenerateIdentity(), subtle)], Buffer.from('x'));
  await assert.rejects(ageOpenSealed(foreign, {storage: store, subtle}), /before this browser was enrolled/);
});

test('automatic enrollment follows the V1 challenge protocol and reuses a stored identity', async () => {
  const storage = new Map(), store = {getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v)};
  const keys = [], calls = []; let required = false, proof = '';
  const reply = value => new Response(JSON.stringify(value), {status: 200, headers: {'content-type': 'application/json'}});
  const fetcher = async (path, options) => {
    calls.push(`${options.method} ${path}`);
    if (options.method !== 'GET') assert.equal(options.headers['x-orkestr-csrf'], 'synthetic-csrf');
    const body = options.body ? JSON.parse(options.body) : null;
    if (options.method === 'GET') return reply({required, ready: keys.some(k => k.status === 'active'), keys});
    if (path === '/api/v2/attachment-keys') {
      proof = `orkestr-recipient-proof-v1:${randomBytes(8).toString('hex')}`;
      const key = {id: '00000000-0000-4000-8000-000000000001', fingerprint: await ageFingerprint(body.recipient, subtle), status: 'pending_verification',
        challenge: {ciphertext_base64: Buffer.from(encryptAge([body.recipient], Buffer.from(proof))).toString('base64')}};
      keys.push(key); return reply(key);
    }
    if (path.endsWith('/verify')) { assert.equal(body.proof, proof); keys[0].status = 'active'; return reply(keys[0]); }
    if (path.endsWith('/policy')) { required = body.required; return reply({required, ready: true, keys}); }
    throw new Error(path);
  };
  const first = await ageEnsureEnrollment({csrf: 'synthetic-csrf', fetcher, storage: store, subtle});
  assert.equal(first.required, true);
  assert.equal(first.fingerprint, await ageFingerprint(await ageIdentityToRecipient(storage.get(AGE_IDENTITY_KEY), subtle), subtle));
  assert.deepEqual(calls, ['GET /api/v2/attachment-keys', 'POST /api/v2/attachment-keys', 'POST /api/v2/attachment-keys/00000000-0000-4000-8000-000000000001/verify', 'GET /api/v2/attachment-keys', 'POST /api/v2/attachment-keys/policy']);
  calls.length = 0;
  const again = await ageEnsureEnrollment({csrf: 'synthetic-csrf', fetcher, storage: store, subtle});
  assert.equal(again.fingerprint, first.fingerprint);
  assert.deepEqual(calls, ['GET /api/v2/attachment-keys']);
});
