# Recipient-encrypted attachments

Orkestr can require every generated or published attachment to be encrypted to
one or more verified `age` recipients. The WebUI fetches only the ciphertext,
decrypts it locally, verifies the embedded plaintext checksum, and saves the
original file. This protects the stored and downloaded artifact from storage
operators, proxies, and corporate scanners that do not hold a recipient private
key.

This boundary applies to outbound published attachments and exports. It does
not encrypt chat text, database rows, secrets, inbound working uploads,
worktrees, repositories, or mounted source files. Whole-platform encryption is
a separate transport, database, and secret-management concern.

## Key enrollment

The first authenticated WebUI session creates a browser-local age identity,
registers its public `age1...` recipient, decrypts the server's random,
short-lived possession challenge, and enables the mandatory policy
automatically. Enrollment is idempotent and retries after transient failures.
Only the random proof and public recipient leave the browser; the private
identity never enters Orkestr.

The identity is remembered in that browser profile so later downloads are
automatic. Instance Settings offers an optional recovery-key export and an
advanced path for adding a separate recovery recipient. Losing every enrolled
identity makes its existing ciphertext unrecoverable.

Confirm the displayed SHA-256 fingerprint out of band before enabling the
policy. Multiple verified recipients can be active, including an explicit
recovery recipient. Every recipient is included in the immutable publication
snapshot.

The browser enables the per-owner fail-closed policy as part of enrollment. For
production, operators must additionally set
`ORKESTR_ATTACHMENT_ENCRYPTION_REQUIRED=1`; that environment setting cannot be
disabled from the WebUI. It is safe to set before the first browser enrollment:
attachment publication remains blocked until automatic enrollment completes.

## Publication boundary

When the policy is enabled, Orkestr:

1. reads the selected source artifact without modifying it;
2. places the original filename, MIME type, size, and plaintext checksum inside
   the encrypted payload;
3. encrypts that payload in the interoperable age file format;
4. validates the complete ciphertext write and checksum;
5. commits only an opaque `.age` attachment name and the ciphertext metadata
   allowlist to the message;
6. exposes only that ciphertext through the authenticated WebUI download API.

The allowlist is limited to the opaque attachment ID/name, ciphertext size and
checksum, format/algorithm version, policy revision, verified recipient IDs and
fingerprints, retention state, and timestamps. Original metadata remains
encrypted. Outbound attachment backups therefore contain ciphertext plus only
this plaintext metadata allowlist; filesystem locations are derived at runtime
and are not persisted in message records.

There is no plaintext fallback. If a required verified recipient is missing,
the source cannot be read, the ciphertext write is incomplete, or validation
fails, publication stops with a visible error.

Protected attachments are WebUI-only. WhatsApp receives the text reply plus a
notice that the protected file is available in Orkestr; it receives neither the
plaintext source nor the `.age` file.

## Rotation and historical files

Rotation and revocation affect future publications. Existing ciphertext stays
bound to its original recipient snapshot. Orkestr cannot re-encrypt existing
ciphertext for a different recipient without a client that can decrypt it.

The normal WebUI setup does not migrate historical attachments. Enforcement
applies to future publications; existing records remain unchanged.

`orkestr doctor system --json` reports missing verified recipients, expired
challenges, incomplete writes, and plaintext residue inside encrypted
publication directories. Rollback must never restore plaintext publication;
disable new publication instead if an older runtime cannot understand the
encrypted format.

Server-side validation covers the ciphertext filename contract, byte length,
checksum, and complete atomic write. The browser then validates the age AEAD
authentication tag, encrypted original metadata, plaintext byte length, and
plaintext SHA-256 checksum before creating the local download. The
recipient-possession challenge is the required client-side canary decryption
before a key can become active; private identities never enter Orkestr.
