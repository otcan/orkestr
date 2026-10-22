# Attachment encryption at rest (V1 parity)

Attachment objects in the conversation attachment store are age ciphertext
(X25519 recipients) for the owner's enrolled browsers, the model of the V1
app (`docs/attachment-encryption.md`). The server never holds a private
identity for them.

## Keys

- Each browser keeps an age identity in `localStorage`
  (`orkestr.attachment-age-identity.v1`, the V1 key on the same origin) and
  registers only its `age1...` recipient.
- `POST /api/v2/attachment-keys` returns a possession challenge: the age
  ciphertext of `orkestr-recipient-proof-v1:<nonce>` for that recipient
  (15 minutes, 5 attempts). `POST /api/v2/attachment-keys/{id}/verify` with the
  decrypted text activates the key. `.../revoke` excludes it from new objects;
  existing ciphertext keeps its recipient snapshot.
- `POST /api/v2/attachment-keys/policy {"required":true}` turns on the
  fail-closed policy (it needs an active key). `ORKESTR_V2_ATTACHMENT_ENCRYPTION_REQUIRED=1`
  forces it for every owner.
- The web UI enrolls automatically after sign-in and then requires
  encryption, as V1 did. `GET /api/v2/attachment-keys` reports the keys, the
  policy and `plaintext_objects` (the doctor check; 0 once sealed).

## Objects

- On import (composer upload, thread files, WhatsApp media) the bytes are
  sealed for the owner's active keys inside the write transaction. Only the
  ciphertext is stored (`attachment_sealed_objects`); `attachment_objects.bytes`
  stays `NULL`. The age plaintext is the V1 payload: filename, MIME type, size
  and SHA-256, then the bytes.
- With the policy required and no active key, imports that carry bytes are
  refused with `409 attachment_encryption_key_required`. Nothing is stored in
  plaintext. With no key and no policy (a fresh install), objects stay
  plaintext until the first key is verified, which seals them.
- Downloads return `application/age` with the recipient fingerprints in
  `x-orkestr-attachment-recipients`. Exports list each object as
  `plain` or `age-x25519-v1`. The browser decrypts, then verifies size and
  digest against the manifest. A browser enrolled after an object was sealed
  cannot open it (no server re-issue, as there is no server key).

## What stays readable on the server

As in V1, the server keeps what agents and WhatsApp delivery need outside the
encrypted store: the provider-readable local copies written at upload time
(`ORKESTR_V2_ATTACHMENT_EXPORT_DIR`, default `<home>/message-attachments`) and
the WhatsApp adapter's own media copies. Manifests (filename, type, size,
digest) also stay readable. Protect the host state accordingly; on the
reference deployment it lives in an encrypted volume.

## Operator import of V1 browser keys

Write `<ORKESTR_V2_HOME>/attachment-recipients-import.json` (service-owned,
mode 0600) before a restart:

```json
{"owner_id": "<v2 owner uuid>",
 "recipients": [{"recipient": "age1...", "label": "Automatic WebUI browser", "verified_at": 1756764588}]}
```

At startup the server imports the active, unrevoked V1 recipients as
`v1_import` keys (idempotent), enables the policy, seals plaintext residue,
and renames the file to `.json.imported`. Only public recipients are copied.
