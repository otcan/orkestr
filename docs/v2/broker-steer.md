# Closed Codex steer wire

`SteerExecution` is an exclusively parent-owned pipe operation, not JSON proof
of authority. Runtime must consume the exact Core-issued steer capability and
fence every actual provider stdin suffix. Python never writes provider stdin.

The envelope has exactly `id`, `method`, `params`; params has `owned_handle`
and `frame`. The inner frame has a canonical UUID-string id, method `turn/steer`,
and params `threadId`, `expectedTurnId`, `input`. Input is one text item with
empty `text_elements`, nonempty UTF-8 text at most 32768 bytes and no NUL.
Both native identities must match the current active turn. Worker/offline and
Claude are unsupported. Setup cannot submit steer.

The request UUID is burned before preparation; at most 128 are retained per
channel. Only one correlated RPC may be pending. BrokerPrepared and the existing
sole-writer handoff remain unchanged. Runtime must complete all fenced suffixes
before accepting a coalesced reply. The only native success result is exactly
`{turnId: <active turn>}` under the same UUID. Wrong, duplicate or post-terminal
replies refuse. Active turn notifications can continue during preparation.
A reply is correlation, never fresh dispatch authority or proof of completion.
Uncertain writes must quarantine, never restore the consumed capability/retry.

Synthetic tests cover matching reply with concurrent progress, replay, pending
requests, foreign identities, closed fields, unsupported roles, and late terminal
replies. Actual Core steer composition and native execution remain unexecuted.
