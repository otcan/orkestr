# Separate trusted Claude package checkpoint

The callable entry is `v2/provider-broker/claude_server.py` with fixed argv
`open-owned-session --protocol orkestr-v2-provider-broker-v1` and required private
Unix stream fd3. `claude-package.json` pins the exact five imported source files.
This inventory is separate from the six-file Codex installation; do not silently
add Claude to an existing Codex package verifier.

The root installer must verify each listed SHA256, stage only those five files
plus a server-private `claude-private.json`, and pin the canonical native launcher
and its complete trusted dependency chain. All executable/import/config ancestors
must be root-owned and non-writable by service/untrusted users; retain a private
receipt of ownership, modes and hashes. Configuration has exactly `executable`,
`account`, `workspace`, `home`, `temporary`: canonical absolute paths, account
referencing the existing authenticated subscription internally, no auth copies.
Public examples contain no selected host configuration. The loader checks
canonical shape; installation ownership/hash verification is a root gate.

One generated UUID and one newly owned child belong to each channel. Open echoes
Core-derived identity and returns `native_session` plus metadata-only opaque
handle. This is a new Claude wire variant, requiring a separate reviewed Runtime
codec; existing Codex codecs must not accept it implicitly. `system/init` is
sanitized to identity only and is not subscription authentication evidence.

`CommitExecution` params are exactly `owned_handle`, `message_id`, `frame`.
The frame is exactly `type:"user"`, `session_id:<generated UUID>`,
`parent_tool_use_id:null`, `message:{role:"user",content:<durable text>}`.
Only Runtime's consumed-capability wrapper may derive and submit this. Message
IDs cannot repeat, and follow-up requires a terminal result on the same child.
There is no durable authority in JSON. Existing BrokerPrepared uses outer ID;
BrokerOutput includes `request_id` for active-turn correlation (null for init).
The broker relinquishes stdin via SCM_RIGHTS; Runtime must hold the respective
actual Core fence around every native writer suffix. Setup cannot submit a turn.

Unknown messages/tools and CancelExecution explicitly refuse. Until installed
Claude control behavior is independently verified, Stop requires the trusted
owned-group cleanup path, kill/reap evidence and separate issued cancellation
acknowledgement. Parent Stop, broker preparation and EOF alone never prove a
successful native interrupt. A partial frame/result loss remains unknown and
must never be retried or used to reissue a consumed grant.

Synthetic tests execute a fake native process with the fixed launcher options,
transfer its sole stdin, and complete two terminal-gated turns with unchanged
PID/UUID. They do not establish installed Claude flag compatibility, whether the
CLI emits init before a prompt, subscription entitlement, ordinary Store/HTTP
composition or production cancellation. Those remain explicit activation gates;
no real provider was started and no account contents were read. Runtime owns the
separate Claude codec/parser lifecycle and consumed attachment; a new parser per
turn must not fabricate a repeated native initialization. Root owns immutable
staging and harmless real-provider acceptance after independent review.
