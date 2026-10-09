# Vault sharing with people outside Orkestr

People without an Orkestr account can get a password from the Vault, or send
one into it, through a normal web browser:

- **Share** (`orkestr vault share`, or **Share…** on a Vault item): end-to-end
  encrypted; the server stores and serves only ciphertext and never holds the
  key.
- **Receive** (`orkestr vault receive`, or **Request from someone…** on the
  Vault page): the outsider's browser encrypts to a per-link public key and
  the submission becomes a Vault item of the link owner.

The Vault page lists active and recent shares and requests with their status
(views, first opened, received) and a **Revoke** button.

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

On the Vault page, **Share…** reveals the password through the normal
recent-sign-in reveal API, encrypts it in the browser with the same format,
posts only the envelope, and shows the link (with the key) once.

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

## Receiving

```sh
orkestr vault receive "Example Portal" [--once] [--ttl 1d] [--label text] [--json]
```

The command prints `<public app url>/s/r/<token>`. Send it to the person who
has the password. When they submit it, a Vault item named after the request
is created in the link owner's vault. From the CLI, the item is granted to the
calling thread, which also gets a record-only note naming the item id (never
the value). `--once` makes it a single-use item (one release to a thread,
valid 24 hours; see [vault.md](vault.md#single-use-items)).

- Each link gets its own RSA-OAEP-3072 key pair. The private key is sealed
  under the vault key (AES-256-GCM, bound to the owner and link) and kept in
  the link record's ciphertext slot, so it is deleted when the link is used,
  revoked or expires. It is never stored or returned in clear.
- The public page `/s/r/<token>` needs no login. The browser encrypts
  `{ username, password }` with a fresh AES-256-GCM key, wraps that key with
  RSA-OAEP-SHA256, and posts only the envelope to `/s/r/<token>/submit`
  (same-origin only). The server decrypts it in memory and seals it as the
  Vault item in the same step.
- One accepted submission per link, enforced under the link store lock.
  Envelopes that do not decrypt leave the link usable but count against the
  per-client lookup throttle. Values are limited to 16 KiB.
- Same headers, CSP and 404 behaviour as share pages.
