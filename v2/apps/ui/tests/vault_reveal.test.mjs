// ORK-784: the owner's browser opens a sealed vault login with its own key.
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createCipheriv, createHmac, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes} from 'node:crypto';
import {AGE_IDENTITY_KEY, ageBech32Decode, ageGenerateIdentity, ageIdentityToRecipient} from '../src/attachments/age.mjs';

const age = (await readFile(new URL('../src/attachments/age.mjs', import.meta.url), 'utf8')).replace(/export /g, '');
const bridge = await readFile(new URL('../src/vault_reveal.js', import.meta.url), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
const run = new AsyncFunction('dioxus', 'fetch', `${age}\n${bridge}`);

// Independent age encryptor on node:crypto (the code under test only decrypts).
const b64 = bytes => Buffer.from(bytes).toString('base64').replace(/=+$/, '');
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
  const nonce = randomBytes(16), key = hkdf(fileKey, nonce, 'payload'), n = Buffer.alloc(12); n[11] = 1;
  return Buffer.concat([Buffer.from(header), nonce, seal(key, n, plaintext)]);
}

const ID = 'vi_0123456789abcdef0123456789abcdef';
const SECRET = 'synthetic-browser-vault-secret';
const login = (itemId) => Buffer.from(`ORKESTR-VAULT-LOGIN/1\n${JSON.stringify({version: 1, owner_id: '00000000-0000-4000-8000-000000000001', item_id: itemId, url: 'https://example.com', domain: 'example.com', username: 'synthetic-user', password: SECRET, notes: 'n', fields: [], totp: null})}`);
async function reveal(id, {status = 200, sealedFor, plaintext, identity}) {
  globalThis.localStorage = {getItem: key => (key === AGE_IDENTITY_KEY ? identity : null)};
  let fetched = null, sent = null;
  const sealed = sealedFor ? encryptAge(sealedFor, plaintext).toString('base64') : '';
  await run({recv: async () => ({id}), send: async value => { sent = value; }}, async (path, options) => {
    fetched = {path, options};
    return Response.json(status === 200 ? {item_id: id, sealed_base64: sealed} : {code: 'unauthorized', message: 'Authentication required'}, {status});
  });
  delete globalThis.localStorage;
  return {fetched, sent};
}

test('the owner browser opens a login sealed for it, bound to its item', async () => {
  const identity = ageGenerateIdentity(), recipient = await ageIdentityToRecipient(identity);
  const other = await ageIdentityToRecipient(ageGenerateIdentity());
  const {fetched, sent} = await reveal(ID, {identity, sealedFor: [other, recipient], plaintext: login(ID)});
  assert.equal(fetched.path, `/api/v2/vault/items/${ID}/sealed`);
  assert.equal(fetched.options.credentials, 'same-origin');
  assert.equal(fetched.options.cache, 'no-store');
  assert.deepEqual(sent, {ok: true, url: 'https://example.com', username: 'synthetic-user', password: SECRET, notes: 'n'});
});

test('a swapped, foreign or unreadable login is refused without its value', async () => {
  const identity = ageGenerateIdentity(), recipient = await ageIdentityToRecipient(identity);
  const swapped = await reveal(ID, {identity, sealedFor: [recipient], plaintext: login('vi_another0123456789')});
  assert.deepEqual(swapped.sent, {ok: false, message: 'This login belongs to another item.'});
  const foreign = await reveal(ID, {identity, sealedFor: [await ageIdentityToRecipient(ageGenerateIdentity())], plaintext: login(ID)});
  assert.match(foreign.sent.message, /saved before this browser was enrolled/);
  const nokey = await reveal(ID, {identity: null, sealedFor: [recipient], plaintext: login(ID)});
  assert.match(nokey.sent.message, /no key yet/);
  const expired = await reveal(ID, {identity, status: 401});
  assert.deepEqual(expired.sent, {ok: false, message: 'Authentication required'});
  for (const result of [swapped, foreign, nokey, expired]) assert.ok(!JSON.stringify(result.sent).includes(SECRET));
  const invalid = await reveal('vi_../../x', {identity});
  assert.equal(invalid.fetched, null);
  assert.deepEqual(invalid.sent, {ok: false, message: 'Invalid login id.'});
});
