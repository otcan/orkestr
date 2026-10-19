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
