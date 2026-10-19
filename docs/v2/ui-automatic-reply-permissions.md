# Owner automatic-reply permissions

The conversation panel consumes Core `d8b86f5e2` and HTTP leaf `32055a685`.
Canonical server registration remains coordinator-owned. It presents observed
policy only: allowing replies does not imply an active connection, send authority,
release of held input, or confirmed delivery. No route creation is exposed.

Each read binds the current session/conversation, request order and exclusive
cursor. The component closes its client on retirement, ignores expired owner
callbacks and reports 401 through the existing session-expiry flow. It displays
one page, requests 16 routes, validates at most 32, and retains at most 256 route
identities to refuse backwards/conflicting policy. Reopening resets that bounded
history; a new read is required. Independent pages are not a stable full-list cut.

Writes use the exact sampled route generation/revision, same-origin cookies and
CSRF. Uncertain failures preserve the original tuple/key while mounted. Navigation
or logout discards pending state; no cross-remount retry persistence is claimed.
A definitive refusal requires refresh. A historical successful receipt also
requires a new read before current permission is displayed; failed refresh clears
the displayed policy. Response limits are 64 KiB, 256 reads and 15 seconds.

Validation: 17 Node state/client/bridge cases, wrapper locked/offline WASM check
and strict Clippy. Bridge cases execute the exact assembled JavaScript with a
synthetic channel; they are not mounted browser or real HTTP acceptance. No
producer, external transport, real permission mutation or browser lease was used.
