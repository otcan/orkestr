# Codex resume metadata

Native resume setup sends `thread/resume` with `excludeTurns: true`. The
installed Codex app-server JSON schema defines this flag as returning thread
metadata and live resume state without populating `thread.turns`. Core's durable
history remains authoritative; startup does not need to download native history.

The broker requires the literal boolean flag and the exact expected native ID,
workspace, subscription provider, approval policy and sandbox. Missing, false,
numeric, unknown or history-selection fields are refused. A resume reply with
nonempty or malformed `thread.turns` is also refused before confirming readiness.
The existing 65,536-byte frame limit is unchanged.

This narrows metadata traffic for long conversations. It does not change the
one-use resume grant, parent FD bootstrap, monotonic request IDs, dispatch fence,
receipt replay, or required owner acceptance. It does not establish the cause
of any separately observed native startup or resume refusal.

Focused validation covers exact native identity, strict flag/key refusal,
history-shaped replies, oversized wire frames and bounded successful metadata.
Protocol evidence can be reproduced without a provider account by generating
`app-server generate-json-schema` into an empty temporary home and inspecting
`v2/ThreadResumeParams.json`.
