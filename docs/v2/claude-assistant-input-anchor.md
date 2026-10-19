# Claude assistant input omission

The pinned Claude Code 2.1.295 headless adapter stamps `user_message_uuid` on
only the first assistant frame for a submitted input. Its stream emits one
assistant frame per completed content block, retaining the same API
`message.id` and optional `request_id` across those blocks. A first frame can
contain only thinking metadata.

A broker channel already owns one selected child reader, one native session,
one serialized consumed input and one terminal lifetime. A new private
`AssistantInput` tracks one response within that lifetime. The first frame must
carry the exact current input UUID. Only after the complete closed frame
validates does it bind the API message ID and the exact presence/value of the
request ID. Subsequent assistant frames may omit both input fields only while
all those bindings still match. The normalized frame contains the already
consumed input UUID; provider text, JSON from HTTP and API message IDs cannot
create a run, input or permission.

The anchor keeps at most 128 unique canonical event UUIDs. It refuses foreign
explicit input UUIDs, unexpected plural input fields, changed/missing response
IDs, changed request IDs, replay, history/subagent flags, invalid content and
all post-terminal assistant output. A fresh child starts without an anchor,
even when resuming the same native session. The existing single-input channel
still refuses interleaved input. A second API response requires explicit future
design; this path does not guess through retries, fallback or tool loops.

Thinking metadata stays discard-only. During cancellation, the existing notice
handler also discards real text. Control ACK and actual interrupted terminal
remain separate. Results never borrow the assistant anchor: they still require
explicit current-input correlation and a fresh terminal UUID. Reaping and Core
admission/acceptance/hold authority are unchanged.

Synthetic HTTP tests exercise a thinking-only first frame followed by genuinely
unstamped text, and refusal of foreign-response, replayed and unanchored frames.
They do not establish real-provider lifecycle acceptance.
