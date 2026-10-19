# Claude assistant thinking metadata

The pinned Claude Code 2.1.295 SDK models `thinking` blocks with exactly
`type`, `thinking`, `signature`, and `redacted_thinking` blocks with exactly
`type`, `data`. These blocks are metadata, never execution Progress.

The broker validates the complete bounded assistant envelope before emitting
anything. It discards these two block shapes, their text, signatures and data.
Only genuine text from a fully validated mixed frame reaches Runtime. A frame
containing only thinking metadata produces no observation, payload or receipt.
Tools, unknown blocks, malformed fields, foreign input/session, missing explicit
input correlation, historical flags and extra authority fields still refuse.

The path requires genuine init, the current consumed input UUID and a fresh
nonnil canonical event UUID. It shares the 128-event telemetry budget, refuses
replay and post-terminal assistant frames, and preserves the existing control
path: while cancellation is active, even genuine text is discarded through the
existing bounded notice handler. Neither metadata nor a control ACK can supply
the separate interrupted terminal or durable Stopped observation.

This is a narrow compatibility correction, not complete native stream support.
The same pinned SDK stamps `user_message_uuid` only on the first assistant
frame of a turn, which may contain only thinking metadata. Later unstamped text
remains refused by the current per-frame correlation guard. This change does
not relabel it or infer input authority from an API message ID. A separately
reviewed correlation design is required before claiming that lifecycle works.
The original nontext failure did not retain its actual block subtype.
