# Claude command lifecycle metadata

The Claude broker accepts the six closed `command_lifecycle.state` values in
the pinned Claude Code 2.1.295 schema: `queued`, `started`, `completed`,
`cancelled`, `discarded`, and `refused`. The frame still has exactly five fields:
`type`, `command_uuid`, `state`, `uuid`, and `session_id`.

`command_uuid` must match the submitted input. The enclosing channel requires
the current native session, an initialized and submitted input, a unique
canonical event UUID, and the existing 128-event telemetry bound. Unknown
states, extra authority-shaped fields, foreign identifiers, duplicate event
UUIDs, and overflow remain protocol failures.

Lifecycle metadata is consumed without forwarding a provider observation.
It cannot initialize the native session, confirm Stop, complete a run, or
authorize another input. In particular, `cancelled` can mean removal from a
queue or a failed consuming turn as well as an interrupted turn. `completed`
does not prove delivery of a result. Native lifecycle frames may appear before
initialization or after the corresponding result; neither position gives them
authority. A second result remains forbidden.

This compatibility change adds only the three previously omitted enum values.
It does not enable Claude Stop. Stop requires separately reviewed control and
native terminal correlation, durable cancellation, and owned process cleanup.

Validation uses synthetic channel frames for all six states before native init
and after a terminal, plus negative authority, scope, identity, and bound cases:

```sh
cd v2/provider-broker
python3 -B -m unittest discover -p 'test_claude*.py'
```
