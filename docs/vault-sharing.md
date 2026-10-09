# Vault sharing with people outside Orkestr

`orkestr vault share` gives someone without an Orkestr account a password from
the Vault through a normal web browser. The secret is end-to-end encrypted:
the Orkestr server stores and serves only ciphertext and never holds the key.

```sh
orkestr vault share "Example Mail" [--ttl 1d] [--views 1] [--passphrase-prompt] [--label text] [--json]
orkestr secret links list            # status, views, opened-at (kind "e2e")
orkestr secret links revoke <link-id>
```

The command reads the granted item's password (like `vault get`), encrypts it
in the CLI with AES-256-GCM under a fresh random key, and sends only the
envelope to `POST /api/secret-links/e2e`. It prints
`<public app url>/s/e/<token>#<key>`. The part after `#` is the key; browsers
never send URL fragments to servers, and the CLI never puts it in a request.
Treat the printed link like the password itself unless a passphrase is used.

`--passphrase-prompt` asks for a passphrase on a hidden prompt (at least 8
characters). The AES key then becomes
`HMAC-SHA256(fragmentKey, PBKDF2-SHA256(passphrase, salt, 600000))`, so neither
the link nor the passphrase alone opens the secret. Tell the passphrase to the
recipient through a different channel.

## Recipient page

`/s/e/<token>` needs no login. `GET` only renders a page with a **Reveal**
button and never consumes a view. **Reveal** posts to `/s/e/<token>/open`
(same-origin only), receives the envelope, and decrypts it with WebCrypto in
the browser; a wrong passphrase can be retried without spending another view.
WebCrypto needs a secure context, so the public app URL must be `https` (or
localhost).

## Security model

- Built on the one-time secret link store (`docs/secret-links.md`): only the
  token's sha256 is stored, the envelope sits in the record's ciphertext slot
  and is deleted on the last view, revoke or expiry.
- `--views` (1 to 10, default 1) is enforced under the store lock, so
  concurrent opens never exceed it. `--ttl` follows secret links (default 15
  minutes, maximum 24 hours).
- Status is coarse: view count and first "opened at" time. No IP address or
  user agent is stored. The audit event `secret_link_opened` carries only
  link metadata.
- Unknown, used, revoked and expired tokens all get the same 404 and count
  against the per-client lookup throttle shared with `/s/<token>`.
- Pages send `no-store`, `no-referrer`, `noindex`, `X-Frame-Options: DENY`
  and a nonce-only CSP (`default-src 'none'`, `connect-src 'self'`); there
  are no third-party scripts.
- When the CLI sends the per-turn thread token, the link belongs to that
  thread's owner, like the vault item.

## Not yet available

- "Share…" from the Vault web page (browser-side re-encryption after the
  recent-sign-in reveal).
- Receiving a password from an outsider into the Vault ("Request from
  someone…" / `orkestr vault receive`).
- A list of active shares with revoke on the Vault page.
