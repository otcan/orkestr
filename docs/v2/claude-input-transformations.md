# Claude input transformation metadata

The partial-message parser previously rejected `input_transformations` as an
unknown header key. Claude Code 2.1.295 explicitly consumes this Messages API
field and forwards it with streamed API messages. Its input-metadata decoder is
at byte offset 217527905 and its stream-metadata stripping adapter at 230710495
in the examined native executable (SHA256
`4503bfe11a6c7fcc1e0b39b5e0d347c04248f750b03b0977b3ad6b531fe6f358`).

The primary schema is pinned to Anthropic's Python SDK commit
[`bcd55fe1d3f0f1240765f8cef04295b67337f55a`](https://github.com/anthropics/anthropic-sdk-python/tree/bcd55fe1d3f0f1240765f8cef04295b67337f55a/src/anthropic/types/beta).
Its `BetaMessage`, `BetaRawMessageDeltaEvent`, and two input-transformation types
define optional nullable metadata and its entry shapes. This is independent
schema evidence. An earlier failure that recorded only an extra-key count does
not establish that this was the actual unknown key.

The broker validates and discards the field on a streamed message header, a
complete assistant message, and a final message delta. Only these shapes pass:

- Missing, `null`, or a list of at most 128 entries.
- Each entry has exactly `type`, `path`, and `reason`.
- `type` is `thinking_dropped` or `thinking_mismatch_allowed`.
- `reason` is `model_binding_mismatch`, `prefix_binding_mismatch`,
  `organization_binding_mismatch`, or `end_user_binding_mismatch`.
- `path` is `messages.<index>.content.<index>`, with one to six ASCII decimal
  digits for each index. This is structural input metadata, never a filesystem
  path or an Orkestr message identifier.

The 128-entry limit and six-digit index limit are local safety bounds, not a
claim of unrestricted API compatibility. Unknown types, fields, reasons, path
shapes, and oversized lists fail closed. No values are retained, hashed, emitted
as output, or used for authority. The entire original frame remains charged to
the existing frame, event, and raw-wire budgets.

This field cannot anchor an input, substitute a first-input echo, change a
session/API message, create Progress, acknowledge cancellation, or supply a
terminal. The existing first-stream and first-assistant correlation, one-response
scope, text hashes, replay fences, cancellation suffix rules, and explicit
interrupted-terminal requirements remain in force. Accepting this metadata does
not enable a provider fallback or any tool or account change. A different API
message or an unsupported fallback block still fails the existing guards.

Tests first reproduce rejection on the prior parser, then cover every supported
type and reason, malformed/oversized metadata, foreign/missing/replayed identity,
unchanged wire accounting, full-frame validation before output, no metadata
retention, and separate ACK/terminal evidence. The existing owned subprocess
tests now carry the field through the actual native stdin/FD3 path, preserving
their text, cancellation, and exact-child cleanup assertions.

```sh
cd v2/provider-broker
python3 -B -m unittest test_claude_input_transformations test_claude_stream_diagnostic -v
python3 -B -m unittest discover -p 'test_claude*.py' -v
```

These are synthetic compatibility checks. An actual provider lifecycle requires
its separately reviewed immutable package and acceptance evidence.
