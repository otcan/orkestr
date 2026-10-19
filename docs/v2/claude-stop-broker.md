# Claude no-tools Stop broker boundary

This source slice implements a private parent-pipe protocol, not Core authority
or product Stop activation. The existing sole Rust provider writer is unchanged.
No Python interrupt write, second writer, new listener or credential path exists.
The six-state lifecycle validator remains the attributed compatibility dependency.

Every CommitExecution input now requires a canonical UUID derived by trusted
Runtime from the consumed message. Positive assistant/result output must echo
that exact input, including the first turn. A plural echo, when present, must be
exactly the singleton input. Results require a distinct canonical event UUID.

After genuine system/init and while that input is active and nonterminal, the
closed CancelExecution envelope is:

```json
{"id":4,"method":"CancelExecution","params":{"owned_handle":"synthetic-handle","frame":{"type":"control_request","request_id":"interrupt:4","request":{"subtype":"interrupt","cancel_queued":false,"for_user_message_uuids":["33333333-3333-4333-8333-333333333333"]}}}}
```

The control latches once before preparation; its bounded request ID cannot reuse
the initialize ID. Outer IDs remain unique and bounded. FD3 mode emits only the
existing BrokerPrepared for outer 4. Runtime must consume the exact issued cancel
receipt and fence every actual native suffix. Python cannot attest the parent
write offset: Runtime must refuse an ACK before the full actual write and must
never restore/retry an uncertain control grant.

An exact success control_response for interrupt:4 with response `{turn:stopped}`
is sanitized into BrokerOutput request_id 4. Only optional EMPTY pending-request
arrays are admitted and stripped. Idle, spared, errors, foreign and duplicate ACKs
refuse. ACK alone never marks a terminal. The separate result remains correlated
to the original execution outer ID (normally 3), not the cancel ID. It requires
exact native/input, distinct canonical result UUID, error_during_execution,
is_error true and terminal_reason aborted_streaming. Aborted-tools and competing
normal completion are unsupported and quarantine. ACK and terminal may arrive in
either order. The first terminal is retained; duplicates refuse.

The terminal projection contains only type, uuid, session_id, user_message_uuid,
subtype, is_error and terminal_reason. Raw result/error/account/model/usage data
is never forwarded in this cancellation projection. Optional accounting data is
bounded and stripped; tool permission denials refuse. Ordinary completion parsing
remains separate. Session-scoped text-only user/assistant notices and selected
text stream/stop events may be discarded while stopping, with 128 unique event
IDs and 16 KiB per notice. No tool/control/system passthrough is added. Closed
lifecycle/rate metadata remains bounded and nonauthoritative, including after a
terminal. Unknown fields, foreign identities and malformed metadata refuse.

Rust must retain the two observations, finish actual owned-tree retirement, and
persist Stopped under the original issued cancellation admission. Neither Python
terminal flags, EOF, ACK, exit, forced cleanup nor telemetry creates that proof.
No product enablement or real-account test is part of this slice.

Run synthetic coverage with:

```sh
python3 -B -m unittest discover -s v2/provider-broker -p 'test_claude*.py'
```

The focused tests include both evidence orders, ACK-only, terminal-only, replay,
foreign/competing/tool terminals, malformed metadata, mandatory first UUID,
64 buffered notices, 32 text stream frames, overflow, and FD3 preparation without
a native queue. Actual Core cancellation/write/reaping and ordinary HTTP gates
remain separate and unexecuted by this source slice.
