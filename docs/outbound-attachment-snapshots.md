# Routed attachment snapshots

Assistant files routed to WhatsApp are copied into the existing thread artifact
directory before their attachment descriptors are persisted or encrypted for
WebUI publication. User uploads and non-routed assistant messages are unchanged.
Already-materialized remote runtime files retain their existing staged location.

Snapshots use content-addressed names, a SHA-256 checksum and a hashed owner/thread
binding. Local snapshots use private directory/file modes (0700/0600), bounded
reads, atomic replacement and filesystem sync. Existing attachment path policy
still determines which files may be read. These measures protect against ordinary
producer cleanup and detect changed bytes; they are not a boundary against a
privileged host attacker or a replacement between validation and bridge reading.

The saved descriptor remains usable after the producer's original file disappears.
Original text links are preserved, without producing duplicate attachments or a
false missing-source notice when the snapshot covers that path.

Before sending, the connector validates both the resolved attachments and the
snapshot obligations retained in the message/outbox. A missing or changed snapshot
must become `failed_retryable`, never a successful text-only delivery. Existing
outbox retry limits, backoff and uncertainty safeguards still apply. Restoring the
exact snapshot bytes permits normal retry; do not bulk-replay historical messages.
An edit cannot silently erase a missing snapshot obligation, though explicit
attachment removal remains an intentional message edit.

With browser download encryption enabled, the private `deliverySource` refers to
the snapshot while the public WebUI attachment remains ciphertext. This is
transport protection, not whole-system file encryption. Snapshot plaintext and
private delivery metadata remain sensitive server data.

## Qualification and remaining work

The regression suite uses a synthetic XLSX workbook and a mocked bridge. It checks
original deletion, persisted message reload/edit, encryption on/off, single-media
delivery, repeated delivery suppression, missing-snapshot recovery, scope mismatch,
symlinks and size limits. A separate-machine bridge receives inline bytes rather
than inaccessible server paths; bridge size limits cannot silently downgrade a
snapshot to text-only. Tests do not send real messages.

## Durable initial staging

Local routed replies persist a private, fsynced staging journal before attempting
copies/publication. An approved producer path missing at initial resolution, a
copy failure, or publication failure preserves the completed reply with a generic
attachment-delivery-pending notice. No text-only send is allowed while staging is
incomplete. The mirror can retry after the source/storage is repaired, with a
persisted retry delay (the outbox retry setting, default 30 seconds). Successful
copies are journaled individually so later publication failure does not require
already-copied producer files to remain available.

The journal is bound to owner, thread, message and text hash, stored privately
(0700 directory, 0600 file). The message exposes only staging ID/state and a
generic notice, not private paths/provider failures. An unavailable journal store
still fails the operation; this does not promise durability after storage loss.
Remote runtime descriptors remain on their authenticated materialization path.

Tests additionally cover initial missing sources and copy failures, private
journal permissions, persisted retry delay, reload/recovery, cross-binding refusal
and no duplicate mocked delivery. No historical messages are automatically replayed.

Snapshot retention currently follows the existing thread artifact storage; this
change adds no automatic age-based deletion. Journal cleanup is report-only: it
lists old completed, unreferenced journals but deletes nothing. Automatic deletion
requires an authoritative inventory serialized against new message/outbox claims.
Pending/uncertain deliveries and their artifact files must remain protected.
