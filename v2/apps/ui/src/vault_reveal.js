// Bridge for vault_view.rs (ORK-784): open one sealed login with this
// browser's own age identity (attachments/age.mjs is prepended). The server
// only ever sends ciphertext; the values exist here until the owner hides them.
const input = await dioxus.recv();
const openLogin = async (id, body, storage) => {
  if (!/^vi_[A-Za-z0-9_-]{6,64}$/.test(id)) throw new Error('Invalid login id.');
  const identity = ageStoredIdentity(storage);
  if (!identity) throw new Error('This browser has no key yet. Reload the app to enrol it.');
  let plain;
  try { plain = await ageDecrypt(identity, ageBase64Decode(String(body?.sealed_base64 || ''), true)); }
  catch (error) {
    throw new Error(error?.message === 'attachment_identity_not_recipient'
      ? 'This login was saved before this browser was enrolled. Replace it to see it here.'
      : 'This login could not be opened.');
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(plain);
  const split = text.indexOf('\n');
  if (split < 0 || text.slice(0, split) !== 'ORKESTR-VAULT-LOGIN/1') throw new Error('Unknown login format.');
  const login = JSON.parse(text.slice(split + 1));
  // The ciphertext names its item: a swapped one is refused.
  if (login?.version !== 1 || login.item_id !== id) throw new Error('This login belongs to another item.');
  return { url: String(login.url || ''), username: String(login.username || ''), password: String(login.password || ''), notes: String(login.notes || '') };
};
try {
  const id = String(input?.id || '');
  if (!/^vi_[A-Za-z0-9_-]{6,64}$/.test(id)) throw new Error('Invalid login id.');
  const response = await fetch(`/api/v2/vault/items/${id}/sealed`, { credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
  const body = await response.json().catch(() => ({}));
  if (response.status !== 200) throw new Error(body?.message || `Login unavailable (${response.status}).`);
  let storage = null;
  try { storage = globalThis.localStorage; } catch { storage = null; }
  await dioxus.send({ ok: true, ...(await openLogin(id, body, storage)) });
} catch (error) {
  await dioxus.send({ ok: false, message: String(error?.message ?? error) });
}
