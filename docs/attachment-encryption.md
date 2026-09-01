# Recipient-encrypted attachments

Orkestr can require every generated or published attachment to be encrypted to
one or more verified `age` recipients. This protects the stored and downloaded
artifact from storage operators, proxies, corporate scanners, and connectors
that do not hold a recipient private key.

This boundary applies to outbound published attachments and exports. It does
not encrypt chat text, database rows, secrets, inbound working uploads,
worktrees, repositories, or mounted source files. Whole-platform encryption is
a separate transport, database, and secret-management concern.

## Key enrollment

Open Instance Settings and add an `age1...` recipient public key. Orkestr
encrypts a random, short-lived proof to the recipient. The browser decrypts the
proof with the private age identity and returns only the random proof. The
private identity is cleared from the form and is never sent to the server.

Confirm the displayed SHA-256 fingerprint out of band before enabling the
policy. Multiple verified recipients can be active, including an explicit
recovery recipient. Every recipient is included in the immutable publication
snapshot.

## Publication boundary

When the policy is enabled, Orkestr:

1. reads the selected source artifact without modifying it;
2. places the original filename, MIME type, size, and plaintext checksum inside
   the encrypted payload;
3. encrypts that payload in the interoperable age file format;
4. validates the complete ciphertext write and checksum;
5. commits only an opaque `.age` attachment name and the ciphertext metadata
   allowlist to the message;
6. sends the same ciphertext publication to browsers and connectors.

The allowlist is limited to the opaque attachment ID/name, ciphertext size and
checksum, format/algorithm version, policy revision, verified recipient IDs and
fingerprints, retention state, and timestamps. Original metadata remains
encrypted. Outbound attachment backups therefore contain ciphertext plus only
this plaintext metadata allowlist; filesystem locations are derived at runtime
and are not persisted in message records.

There is no plaintext fallback. If a required verified recipient is missing,
the source cannot be read, the ciphertext write is incomplete, or validation
fails, publication stops with a visible error.

## Rotation, revocation, and migration

Rotation and revocation affect future publications. Existing ciphertext stays
bound to its original recipient snapshot. Orkestr cannot re-encrypt existing
ciphertext for a different recipient without a client that can decrypt it.

Legacy plaintext assistant attachments can be migrated per thread with
`POST /api/attachment-encryption/migrate`. The default is a dry run. Sending
`{"threadId":"...","dryRun":false}` encrypts the publication metadata
atomically while leaving the original working source untouched. Re-encrypting
existing ciphertext is reported as `client_assisted_required`.

`orkestr doctor system --json` reports missing verified recipients, expired
challenges, incomplete writes, and plaintext residue inside encrypted
publication directories. Rollback must never restore plaintext publication;
disable new publication instead if an older runtime cannot understand the
encrypted format.

Server-side validation covers the ciphertext filename contract, byte length,
checksum, and complete atomic write. It cannot validate the age AEAD
authentication tag without a recipient private key. The recipient-possession
challenge is the required client-side canary decryption before a key can become
active; private identities never enter Orkestr.
