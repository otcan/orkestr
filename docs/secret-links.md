# One-time secret links

One-time secret links let an agent exchange a secret with the instance owner
without the value ever passing through chat, WhatsApp, thread messages, logs,
or the agent's own context.

- **Share** (Orkestr -> owner): `orkestr secret share` creates a link. The
  owner opens it, presses **Reveal**, and sees the value once with a copy
  button. The stored ciphertext is destroyed before the page is sent.
- **Request** (owner -> Orkestr): `orkestr secret request <name>` creates a
  link with a form. The owner pastes the value; it is stored encrypted by the
  secure-input secret manager as `secret://user/<owner>/<name>` and the agent
  uses it by reference (see `docs/secret-manager.md`).

## CLI

```sh
# Share a stored secret without the agent ever seeing it
orkestr secret share --from secret://user/<owner>/<name> [--thread <id>]
# Share a value from stdin or a hidden TTY prompt (never as an argv flag)
printf '%s' "$VALUE" | orkestr secret share --stdin [--ttl 2h] [--label text]
# Ask the owner for a value
orkestr secret request service/api-token [--thread <id>] [--ttl 15m] [--label text]
# Metadata only
orkestr secret links list [--json]
orkestr secret links revoke <link-id> [--json]
```

`share` prints only the link (`<public app url>/s/<token>`). `--value` and
`--secret-value` are refused so values never land in shell history. `--json`
returns `{ ok, link, url }`, where `link` is metadata only.

`--ttl` accepts `90s`, `15m`, `2h`, `1d` (default 15 minutes, minimum 1
minute, maximum 24 hours). Values are limited to 16 KiB. Request names must
already be in secure-input normal form (lowercase `a-z0-9_.-/` segments).

When `--thread` is given the link owner is that thread's owner. On a request
link submission Orkestr appends a passive, record-only note to the thread that
names the secret and its handle, never the value.

## API

All routes are authenticated like other `/api` routes; callers may only act
for owners they can access, as with the secure-input APIs.

- `POST /api/secret-links/share` `{ value | from, ttl?, label?, threadId? }`
- `POST /api/secret-links/request` `{ name, ttl?, label?, threadId? }`
- `GET /api/secret-links` (metadata only)
- `POST /api/secret-links/<id>/revoke`

## Security model

- **Token**: 32 random bytes, base64url, in the link path. Only its sha256 is
  stored (`ORKESTR_HOME/secrets/secret-links.json`, mode 0600). Listings use a
  separate non-secret link id.
- **Login required**: the pages at `/s/<token>` require a real browser
  session (pairing or Keycloak) whose user id equals the link owner.
  Administrators cannot open other users' links; foreign or unknown tokens
  get the same 404. Machine credentials (the CLI token an agent holds),
  shared-app sessions and auth-intent sessions are refused, so the agent that
  created a link cannot open it. Anonymous visitors get a sign-in redirect
  (`/auth/login?return=...` with Keycloak) or a 401, and nothing is consumed.
  Instances running without authentication cannot open links at all.
- **Why `/s/`**: paths outside `/api/` and `/oauth/` are reachable before
  pairing, so the auth middleware still resolves a session cookie into the
  real principal and otherwise marks the request anonymous. The handlers
  reject anonymous requests, so this does not open anything else.
- **Previews cannot burn links**: `GET` only renders a confirmation page.
  Reveal and submit are `POST` only and pass a same-origin check (matching
  `Origin`, or `Origin: null` with `Sec-Fetch-Site: same-origin`).
- **Single use**: reveal/submit run under the link store's in-process and
  file lock; the link is marked used (and share ciphertext deleted) and
  written to disk before the value is rendered. Concurrent reveals yield
  exactly one value.
- **Expiry**: expired links are treated as used; their ciphertext is purged
  on access, by the sweep on every create/list, and by the server's
  maintenance loop (every `ORKESTR_INBOUND_UPLOAD_CLEANUP_INTERVAL_MS`,
  default 5 minutes) even when nobody touches the link. Used/expired/revoked
  metadata is kept for 24 hours, then dropped.
- **Encryption**: share values use the secure-input AES-256-GCM key
  (`ORKESTR_SECURE_INPUT_KEY`, `ORKESTR_SECRET_KEY`, or
  `secrets/secure-input.key`).
- **Headers**: `Cache-Control: no-store`, `Referrer-Policy: no-referrer`,
  `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
  `X-Robots-Tag: noindex`, a nonce-only `Content-Security-Policy`
  (`default-src 'none'`), and
  `X-Orkestr-Secure-Input: noMirror,noCapture,noCodexContext,noScreenshot`.
- **Throttling**: unknown or foreign token lookups count against a durable
  per-client limit (`ORKESTR_SECRET_LINK_LOOKUP_LIMIT`, default 20 per
  `ORKESTR_SECRET_LINK_LOOKUP_WINDOW_MS`, default 15 minutes); over the limit
  every lookup returns 429.
- **No value leaks**: audit events (`secret_link_created`, `_revealed`,
  `_submitted`, `_expired`, `_revoked`) carry only link id, kind, name, owner
  and thread id. Values never appear in events, thread messages, logs, error
  pages, list responses, or `share` output.
