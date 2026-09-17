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

This increment does not recover a producer file already absent before initial
attachment resolution. Snapshot read/write failures before message persistence
also still reject projection rather than creating a separate durable staging
intent. That intent/recovery path remains required for full delivery recovery.
Snapshot retention currently follows the existing thread artifact storage; this
change adds no automatic age-based deletion. Cleanup must preserve files referenced
by pending or uncertain deliveries. Historical delivered/text-only records are
not migrated or replayed automatically.
