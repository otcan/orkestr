# Vault: passwords and authenticator codes

Orkestr includes a small password manager ("vault") with an authenticator
(TOTP/HOTP). Every Orkestr user has their own isolated vault. Agents running in
a thread can use credentials the owner assigned to that thread, without the
values entering chat or model context.

## Features

- Logins: name, URL (normalized domain), username, password, notes, tags and
  extra fields.
- Authenticator: RFC 6238 TOTP and RFC 4226 HOTP with SHA1/SHA256/SHA512, 6 or
  8 digits and a configurable period (default 30 s). HOTP counters advance on
  every issued code.
- Imports: Bitwarden CSV, 1Password CSV, Chrome/Edge CSV, `otpauth://` URIs and
  Google Authenticator exports (`otpauth-migration://offline?data=...`).
- Per-thread grants, owner approvals for authenticator codes and an audit trail.

## Security model

- **Envelope encryption.** Each item has its own random 256-bit data key. The
  secret payload (username, password, notes, TOTP configuration, extra fields)
  is encrypted with AES-256-GCM under the data key; the data key is wrapped with
  AES-256-GCM under the vault key. Both use the additional authenticated data
  `vault:v1:<ownerUserId>:<itemId>`, so ciphertext cannot be moved between users
  or items. Envelopes carry a version and a non-secret key id for future key
  rotation.
- **Plaintext metadata only:** id, name, URL, domain, tags, `hasPassword`,
  `hasTotp`, timestamps, `lastUsedAt` and thread grants.
- **Storage:** `<ORKESTR_HOME>/users/<user-id>/secrets/vault.json` (mode 0600,
  written under a file lock).
- **Vault key:** 32 bytes from `ORKESTR_VAULT_KEY` (base64) if set, otherwise
  generated once into `<ORKESTR_HOME>/secrets/vault.key` (mode 0600). It is
  separate from the secure-input key. If the key file exists but cannot be read
  or parsed, the vault fails closed; it is never regenerated.
- **Back up the vault key separately.** Without `vault.key` (or the value of
  `ORKESTR_VAULT_KEY`) the vault cannot be recovered. Do not store the key
  in the same backup as the vault files if you can avoid it.
- Values are never written to logs, events, errors or thread messages. Errors
  use value-free codes such as `vault_item_not_found`.

## Access rules

| Who | Can do |
| --- | --- |
| Owner (their own signed-in browser session) | List, create, update, delete, import, grant/revoke threads, read codes, approve/deny code requests |
| Owner, signed in within the last 15 minutes | Additionally reveal passwords/notes and export TOTP secrets |
| Admin | Only counts for other users (`GET /api/vault/status?userId=`); never their contents |
| Agent (local CLI credential plus the thread token of its runtime turn) | List metadata of items granted to its thread; read username/password of granted items (automatic, audited); request authenticator codes (owner approval per code) |

Anonymous requests, machine credentials, shared-app and auth-intent sessions
cannot use the owner API. A reveal without a recent sign-in returns
`401 {"error":"vault_reauth_required"}`; the WebUI then sends the user through
`/auth/login?return=...`.

Rate limits (per hour): agent secret reads 30 per item and thread, agent code
requests 20 per thread, owner reveals/exports 120, owner code reads 600.
Override with `ORKESTR_VAULT_AGENT_READ_LIMIT`, `ORKESTR_VAULT_AGENT_TOTP_LIMIT`,
`ORKESTR_VAULT_OWNER_REVEAL_LIMIT` and `ORKESTR_VAULT_OWNER_TOTP_LIMIT`.

Audit events (no values): `vault_item_created`, `vault_item_updated`,
`vault_item_deleted`, `vault_imported`, `vault_grant_changed`,
`vault_secret_read`, `vault_totp_requested`, `vault_totp_approved`,
`vault_totp_denied`, `vault_totp_issued`, `vault_reveal`.

### How agents are identified

Agents are identified by a **thread token**, not by a thread id they name.
For every managed runtime turn Orkestr issues a fresh random token
(`ovt_...`), bound to that thread and turn, and injects it into the runtime
environment as `ORKESTR_VAULT_THREAD_TOKEN`. The server stores only its
SHA-256 hash (`<ORKESTR_HOME>/secrets/vault-thread-tokens.json`, mode 0600).
The token expires with the turn timeout (plus 5 minutes) and is revoked when
the turn ends, so a thread that was already running picks up a token on its
next turn without a restart.

`orkestr vault` sends the token in the `X-Orkestr-Thread-Token` header (never
in the URL, argv or the `exec` child environment). The agent routes require
both the local CLI machine credential and a live token, derive the thread from
the token and reject:

- a missing token: `401 vault_thread_token_required`;
- an unknown, expired or revoked token: `401 vault_thread_token_invalid`;
- a `threadId` that differs from the token's thread: `403 vault_thread_token_mismatch`.

So a process holding the shared CLI credential can no longer pick another
thread's grants by naming it. Tokens never appear in logs, the perf log,
events or thread messages.

Limits: the token lives in the runtime's process environment, so it does not
isolate processes running as the same OS user that can read each other's
environment. Turns of runtimes that do not receive a token yet (for example
Codex app-server threads) cannot use agent vault access in the default mode.

**Legacy mode (operator opt-in, for rollout only):** setting
`ORKESTR_VAULT_ALLOW_LEGACY_THREAD_ID=1` on the server additionally accepts
requests without a token that name a thread (`ORKESTR_THREAD_ID` or
`orkestr whereiam` by cwd, as before). In that mode thread identity is
cooperative again: any local process holding the CLI credential can name any
thread. A token, when sent, is always enforced. Owners always keep full access
to their own vault through the signed-in WebUI.

## Agent usage

Vault items are a separate store from `orkestr secret` (secure-input secrets):
an item the owner granted to a thread never shows up in `orkestr secret list`
or in environment variables. To keep agents from concluding a credential is
missing, `orkestr secret list` points to `orkestr vault list` (on stderr, or as
a `vault` key in `--json` output), headless Claude Code turns carry a standing
runtime notice about the Vault, and `orkestr whereiam --json` reports
`capabilities.vault`.

Prefer `exec`: the values go into the child process environment only.

```sh
orkestr vault list
orkestr vault exec "Example Mail" -- ./scripts/login.sh   # uses $VAULT_USERNAME / $VAULT_PASSWORD
orkestr vault get "Example Mail" --field username          # prints the value; avoid for passwords
orkestr vault totp "Example Mail" --wait 120               # waits for the owner's approval
```

Never print passwords into chat, WhatsApp or thread messages. Secret values are
never accepted as command-line arguments.

## Authenticator approvals

`orkestr vault totp <item>` creates a pending approval (`vap_...`, valid for
5 minutes) unless one is already pending. The owner approves or denies it in the
WebUI (`GET /api/vault/approvals`, `POST /api/vault/approvals/:id/approve|deny`).
After approval the agent can fetch exactly one code within 5 minutes; the next
code needs a new approval.

## Imports

`POST /api/vault/import {"format": "auto"|"bitwarden"|"1password"|"chrome"|"otpauth", "content": "..."}`
accepts up to 2 MB and 5000 rows and returns
`{ imported, skipped, withTotp, reasons: [{ row, reason }] }` with value-free
reasons. `login_totp` / `OTPAuth` columns may hold an `otpauth://` URI or a bare
base32 secret.

Google Authenticator: use "Transfer accounts > Export accounts", scan the QR
code with any QR reader and paste the `otpauth-migration://offline?data=...`
text (one line per QR code). Each account becomes a vault item; pass
`"attachToExisting": true` to attach codes to an existing item without TOTP
whose name or domain matches the issuer.

## HTTP API

All routes are under `/api/vault` and use JSON.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/items` | Metadata plus username |
| POST | `/items` | `{ name, url?, username?, password?, notes?, tags?, totpUri? \| totpSecret? }` |
| PATCH | `/items/:id` | Any subset; `password: ""` clears; `totpUri: ""` clears TOTP |
| DELETE | `/items/:id` | |
| POST | `/items/:id/reveal` | `{ password, notes }`, recent sign-in required |
| GET | `/items/:id/totp` | `{ code, expiresInSeconds, period, digits }` |
| POST | `/items/:id/totp-secret` | `{ otpauthUri }`, recent sign-in required |
| PUT | `/items/:id/grants` | `{ threadIds: [...] }`, the owner's own threads only |
| POST | `/import` | See Imports |
| GET | `/approvals` | Pending and recent approvals |
| POST | `/approvals/:id/approve`, `/approvals/:id/deny` | |
| GET | `/status` | `{ itemCount, totpCount, keySource, keyFilePresent, pendingApprovals }` |

Agent routes (`/api/vault/agent/items`, `/credentials`, `/totp`) are for the CLI
only and need the `X-Orkestr-Thread-Token` header (see "How agents are
identified").
