# Attachment export custody and interrupted preparation

The optional sealed selected-service plan field `attachment_export_dir` is
copied into the pinned service descriptor and supplied only to the server as
`ORKESTR_V2_ATTACHMENT_EXPORT_DIR`. Existing plans without the field keep their
existing default. A split authority/executor installation must explicitly use
an export directory outside its private Core and provider homes.

Provision the directory separately: its owner is the authority UID, its group
is the service/executor shared GID, and its mode is 0700 or 0750. Every ancestor
must be a real directory owned by root or the authority and not group/other
writable. Aliases, relative components, overlap with Core, account, workspace,
package, ledger or control paths are refused before staging. Validation reads
only metadata of the external export hierarchy; it does not traverse Core from
the executor role. For a split bounded provider, Root initializes the exact
authenticated launch conversation's empty authority-owned 0750 subdirectory
before spawning the broker. Root also grants traversal on the sealed export
root. The publisher grants 0640 file access only inside the final authorization
lease.

The bounded provider receives a read-only mount of that conversation subdirectory
at its original absolute path, matching attachment receipts. The conversation
comes exclusively from Root's authenticated one-use launch capsule. Other
conversations, Core and ingest keys are never mounted. Directory mounts expose
later atomic publications to an already-running provider without remounting.
The helper requires the root-manager launch hook; selecting the optional plan
field alone does not qualify a split provider launch.

The writer holds a kernel exclusive lock before a private `.UUID.UUID.tmp`
name becomes visible. Startup recovery opens directories and files without
following aliases, retains directory descriptors, skips locked active writers,
and unlinks only authority-owned single-link regular 0600 temporary files with
matching namespace and inode checks. SIGKILL releases the lock, allowing the
next startup to remove incomplete plaintext before accepting requests. It
never removes published provider files, unknown names, hardlinks or symlinks.
A kill in the initial allocation window can leave an empty `.allocating`
file; it contains no plaintext and is deliberately outside the cleanup scope.

This recovery is for incomplete preparation. Completed provider-file retention
and whole-store quota/backup budgets remain separate operational requirements.
The server's existing 4 GiB reservation is ciphertext capacity; provider
plaintext and SQLite/WAL/backup overhead require additional disk capacity.
