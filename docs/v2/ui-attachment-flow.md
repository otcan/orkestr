# Thread files client checkpoint

The Conversation surface mounts a separate Thread files panel. It discovers
bounded authenticated collections using the Core 859b0747 attachment page ABI
and the Isolation d91ade7 discovery route. Transfer paths and JSON octet arrays
follow Isolation 146bcb4 and Core 9cd9268. No browser-session or backend files
are authored by this slice.

The first authenticated page supplies the canonical owner even when empty.
Uploads and archive copies receive fresh manifest/reference identities and
clear message associations. These are conversation files, not assistant inputs
or message attachments. Import/export uses JSON archives and is bounded to the
published encoded/raw limits.

The client freezes mutation bytes and keys for uncertain retries while mounted.
Navigation/logout aborts owned requests and discards panel state; an uncertain
mutation may already have committed and must be discovered on return before
creating another copy. No automatic retry runs after remount.

Downloads validate metadata, exact length and content type, raw SHA-256, and
scope before offering a browser download. A second manifest read checks removal
after the byte read. Concurrent removal after that final read cannot revoke
bytes already offered. Removed/inert references never request bytes. Inert
integers beyond JavaScript's safe range are refused rather than rounded.

Author validation: six client behavior cases plus eighteen existing verifier/
presentation cases pass. Locked offline WASM check and strict Clippy cover the
mounted Rust component. Matching registered server and browser acceptance remain
required; this checkpoint does not claim HTTP/storage/browser completion.

## Metadata response bounds

A later root reproduction showed that the initial 1 MiB JSON default rejected
valid inert metadata, independently of the 68 MiB archive cap. The successor
uses route-specific finite bounds. Each manifest permits 128 references; inert
strings permit 4096 + 1024 + 128 UTF-8 bytes. Six encoded bytes per source byte
covers JSON control escaping; 512 bytes per reference covers keys, UUIDs,
state and numeric fields; 1024 bytes covers the manifest envelope. Pages permit
16 such manifests plus a 1024-byte page envelope. Import receipts additionally
reserve 256 bytes for each of 128 mapping pairs and a 1024-byte envelope.
The existing 65536-read and 30-second request limits remain.

Regression coverage includes a valid two-manifest plain-text page exceeding
1 MiB, a valid escape-heavy 128-reference manifest and import receipt exceeding
1 MiB, and oversized page/open streams that must cancel. Attachment Node tests
now pass 28/28. The old paired artifact remains unchanged and does not contain
this correction; matching browser acceptance requires the successor bundle.
