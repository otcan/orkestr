# V2 Vault: owner credentials for stored logins (ORK-784)

The owner manages these items on the Credentials page (`credentials.md`,
ORK-826), which can also use OpenBao as the store instead of this vault.

The V1 app has a password vault (`docs/vault.md`). Its items can only be
added through a V1 browser session, and the stored-login helper (a root-run
deployment tool that types a saved login into a managed desk without showing
it to anyone) reads V1's files directly. This page describes the V2-native
vault that replaces it, the one-time import from V1, and the rollout that
leaves the V1 vault read-only and then retired.

Rules that hold throughout: a secret value never reaches a chat, a thread
message, a log, a Git commit, or a browser other than the owner's own view of
an item. Errors and audit records carry fixed codes and ids, never values.

## 1. Data model

Migration `0099_vault.sql` (0098 is reserved by the local-files change; see
"Rollout") adds four tables. Nothing existing changes.

| Table | Holds |
| --- | --- |
| `vault_items` | One login per row. Plain metadata: `id` (`vi_` + 32 hex; imported items keep their V1 id), `owner_id`, `name`, `url`, normalised `domain`, `tags`, `has_password`, `has_totp`, `single_use`, `revision`, creation, update, login-update and last-use times. Secret part: `sealed` (age ciphertext), `sealed_sha256`, and `recipients` (fingerprints the ciphertext was sealed to). |
| `vault_thread_grants` | V1 thread grants carried over unchanged: `(item_id, v1_thread_id, granted_at)`. Deleted with the item. |
| `vault_import_sources` | One row per imported V1 item: `(source, source_id) -> item_id`, the source checksum and the item revision the import wrote. This is what makes the import idempotent. |
| `vault_audit` | Value-free events: `item_created`, `item_updated`, `login_replaced`, `item_deleted`, `grants_changed`, `import_applied`, `owner_reveal`, `stored_login_read`, `stored_login_check`, `stored_login_refused`, with item, chat, desk, site, operation and a short code. |

The sealed part is one unit: `ORKESTR-VAULT-LOGIN/1\n` followed by JSON
`{version, owner_id, item_id, url, domain, username, password, notes, fields,
totp}`. URL and domain are sealed together with the password on purpose (see
below), so changing the URL means replacing the login. Name and tags are plain
metadata and can be edited alone.

## 2. Encryption at rest

The vault reuses the attachment model (`attachment-encryption.md`): age
(X25519) ciphertext, and **the server holds no identity that opens it**.

Each login is sealed, inside its write transaction, to:

1. **The stored-login reader recipient.** Its private identity is generated
   and kept by root on the host, in a root-only file next to the helper. The
   server only knows the public `age1...` recipient and the SHA-256 of the
   reader's access token (section 5).
2. **The owner's active browser recipients**: the same keys the web UI already
   enrols for attachments (`/api/v2/attachment-keys`). The browser keeps its
   identity in local storage, so the owner can view a login in a browser that
   was enrolled when it was sealed.

What the server can and cannot do:

| | Server |
| --- | --- |
| Read stored passwords from the database, a backup or a stolen disk | No: only ciphertext and public recipients are stored |
| See a password the owner types in the web UI or an import sends | Yes, in memory for the duration of that request, then only ciphertext is written |
| Send a login to a site of its choosing through the helper | No: the helper decrypts and uses the **sealed** URL and domain, checks the item id inside the ciphertext, and only types on an HTTPS page of that domain |
| Hand ciphertext to the helper or the owner's browser | Yes, that is how both read it |

So the helper, which must type passwords, decrypts on the host as root; the
web server does not. Root on the host can read everything, as before.

Consequences, stated so nobody is surprised:

- A browser enrolled after a login was sealed cannot show it. Replace the
  login (or re-run the import) to include the new browser.
- Rotating the reader identity needs a re-seal: root decrypts with the old
  identity and re-imports. The procedure is the import tool run against V2
  instead of V1 and is not needed for this rollout.
- If no reader is configured when a login is written, it is sealed for the
  owner's browsers only and the stored-login read refuses it
  (`credential_not_sealed_for_reader`) until the login is replaced. If there
  is neither a reader nor an enrolled browser, the write is refused
  (`vault_recipient_required`).

## 3. Owner routes (web UI)

All owner routes accept **only a password-signed-in browser session** (session
kind `browser`). Machine Bearer sessions and service-credential sessions (the
adapter's) are refused with 401. Every mutation goes through the router's
Origin, Host and `x-orkestr-csrf` guard.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/v2/vault` | Status: item count, reader configured and its fingerprint, active browser recipients, whether a write can be sealed |
| GET | `/api/v2/vault/items` | Metadata, grants and recipients; never ciphertext or values |
| POST | `/api/v2/vault/items` | `{name, url, username, password, notes, tags}`; sealed before storage |
| PATCH | `/api/v2/vault/items/{id}` | `{expected_revision, name?, tags?}` |
| PUT | `/api/v2/vault/items/{id}/login` | `{expected_revision, url, username, password, notes}`: replaces the sealed login |
| PUT | `/api/v2/vault/items/{id}/grants` | `{expected_revision, v1_thread_ids}` |
| DELETE | `/api/v2/vault/items/{id}` | |
| GET | `/api/v2/vault/items/{id}/sealed` | Ciphertext for the owner's browser to decrypt; audited as `owner_reveal` |
| POST | `/api/v2/vault/import` | Section 6; body up to 2 MiB, 500 items |
| GET | `/api/v2/vault/audit` | Newest value-free events |

The Settings page has a Vault section: list, add, edit name and tags, replace
a login, delete, show a login (decrypted in the browser), thread grants, the
import and the audit list. Responses use `Cache-Control: no-store`.

## 4. Stored-login read API (helper)

`POST /api/v2/vault/stored-login`, called by the root helper while it holds the
desk lease:

```json
{"conversation_id": "<uuid>", "desk": "<slug>", "fencing_token": "<lease token>",
 "site": "app.example.com", "mode": "auto", "operation": "<broker op id>", "check": false}
```

- Authentication: header `x-orkestr-vault-reader` with the reader token; no
  Cookie, Authorization or Origin. The server compares SHA-256 digests.
- The conversation must hold the active lease of that desk with that fencing
  token (the same fence the desk lease routes use). The V1 thread of the lease
  comes from the server's lease record, not from the request.
- `mode: "auto"` is the automatic stored-login policy of the helper: exactly one
  password login that is not single-use and whose domain equals the site or is
  a parent of it (never a sibling or a subdomain of the site), sealed for the
  current reader. None gives `404 no_credential_for_site`, more than one
  `409 credential_ambiguous`.
- `mode: "configured"` keeps the helper's per-chat allow-list: `item_ids` (at
  most 16) are the only candidates, the item must be granted to the lease's
  V1 thread, and the domain may match in either direction, as in V1.
- `check: true` returns metadata only (the helper's read-only `--check`).
- The response is `{item_id, url, domain, login_updated_at_ms, sealed_base64}`.
  Every answer, including refusals once the reader is authenticated, writes one
  audit event. Reads are rate limited (60 per minute).

The helper keeps its own policy (owner desks, proven chat, audit-before-use),
its root ledger of chat-and-desk grants and its audit log. V2 adds the server
side of the same decision, so neither side alone can widen it.

## 5. Grants and audit

- **Thread grants** (V1 `threadGrants`) are imported as data and editable by
  the owner. They only matter to `configured` mode. V2 has no agent route that
  returns a value to a thread: the V1 `orkestr vault exec` path is not
  carried over, and the V1 events show it unused.
- **Automatic stored-login grants** stay where they are: the helper's root
  ledger and audit log (owner decision of 2026-11-10).
- **Audit**: `vault_audit` as above. The owner sees it in the UI. It holds no
  values; the tests scan responses, audit rows and the database file for a
  synthetic password.

## 6. One-time import from V1

The import runs as root on the host. It never writes plaintext to disk and
never prints a value.

1. It reads the V1 vault with V1's own code and key, and opens each item in
   memory.
2. For every item it computes `source_checksum = SHA-256` of the canonical V1
   record **as stored** (metadata plus the V1 envelope, which is ciphertext).
   No checksum is computed over plaintext, so nothing in V2 can serve as a
   password hash.
3. It signs in as the owner (browser session), posts the items to
   `POST /api/v2/vault/import`, and signs out.
4. The server seals each item for the reader and the owner's browsers and
   answers per item:

   | Outcome | When |
   | --- | --- |
   | `imported` | new source id; the V2 item keeps the V1 id when it is free |
   | `unchanged` | same source id and checksum; nothing is written |
   | `updated` | the V1 item changed and the V2 item was not edited since the last import |
   | `conflict` | the V1 item changed and the owner also edited the V2 item; nothing is written |
   | `deleted_in_v2` | the owner deleted the imported item in V2; it is not brought back |

5. It verifies: for every item it fetches the V2 ciphertext, decrypts it with
   the reader identity, and compares URL, username, password and notes with
   the V1 values in memory. It prints only ids, outcomes and
   `verified: true|false`, and keeps a root-only report of ids and checksums.

Re-running the import is safe at any time; that is how items the owner still
adds in V1 during the migration window get copied.

## 7. V1 becomes read-only, then retired

After the import is verified and the helper reads V2:

1. Root makes the V1 vault file immutable (`chattr +i` on the owner's
   `vault.json`). V1 and the helper's fallback can still read it; every V1
   write (UI, CLI, request and receive links) fails instead of creating an
   item V2 would not have. `chattr -i` undoes it.
2. The helper's V1 fallback is switched off.
3. After a quiet period with no `desk_login` event that used V1, the V1 vault
   file and key are archived in the encrypted off-site backup and removed from
   the V1 home. That retires the V1 vault.

## 8. Rollout

1. Merge order: the local-files change (migration 0098) first, then this one
   (0099). The store refuses a database whose applied migrations are not an
   exact prefix of the binary's list, so 0099 must never be deployed before
   0098; if this change lands first it is renumbered to 0098.
2. Root creates the reader identity and token on the host and writes the
   server-side file (`<ORKESTR_V2_HOME>/vault-stored-login.json`, or the path
   in `ORKESTR_V2_VAULT_STORED_LOGIN_CONFIG`): format, owner id, recipient and
   the token's SHA-256. The server loads it at start; a missing or invalid
   file only disables stored-login reads.
3. Deploy through the release train.
4. Run the import (section 6) and its verification.
5. Switch the helper to V2 first, V1 as fallback. Watch `desk_login` results
   and the V2 audit for one working day.
6. Make V1 read-only, turn the fallback off, then retire (section 7).

Rollback: until step 6 the V1 vault is untouched, so switching the helper back
to V1 is a configuration change. The V2 tables are additive.
