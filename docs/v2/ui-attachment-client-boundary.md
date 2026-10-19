# Attachment client boundary

The UI owns new presentation and download-verification modules. Core owns the
manifest, storage, owner authorization, export/import references and download
contract. Migration owns the independent synthetic roundtrip oracle. No attachment
route or DTO is currently consumed by this UI checkpoint.

Before implementing the client, the published immutable contract must specify:

- Authorized attachment and conversation/reference identity, including which
  manifest fields must match a download and how removed/missing references behave.
- Declared byte length, digest algorithm/encoding, maximum supported size, and
  whether the digest covers the exact downloaded representation.
- Display filename and media type semantics, authenticated relative download
  route, response statuses, redirect policy and content-encoding behavior.
- Export/import identity preservation or remapping. The client must not derive
  authorization from a filename, digest, imported reference or source-owner ID.

The bounded implementation will consume that exact ABI, validate the selected
reference/scope, download with the existing same-origin cookie flow, and bound
bytes while reading. It will check exact length and digest before making a save
available. Metadata remains plain text; files are never executed or automatically
previewed. Filename handling will avoid path interpretation. Download integrity
means agreement with the authorized manifest, not independent proof of origin.

Owner/session and selection generations will fence asynchronous reads, digest
completion and save availability. Logout, scope changes and component cleanup
must abort owned reads and discard buffered bytes and object URLs. An uncertain
or failed download never becomes a verified save. A redirect must not introduce
an unreviewed external download surface.

Synthetic client tests will cover valid and empty bytes where permitted,
corruption, truncation, oversized/chunked responses, wrong references, tombstones,
redirect refusal, logout during read/hash and stale callbacks after navigation.
These tests complement the independent Store roundtrip oracle; neither substitutes
for a matching mounted browser test after server registration.

Current evidence is ownership and dependency coordination only. No attachment
DTO, guessed route, browser lease, real import, download, backend edit, dependency
resolution or attachment acceptance is claimed. Client implementation awaits the
canonical immutable ABI.
