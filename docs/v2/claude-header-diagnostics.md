# Closed Claude header diagnostics

The streaming parser's `message_header` key guard refuses a non-object, a missing
required key, or an additional key. A refusal location alone cannot distinguish
those cases. The pinned Claude Code 2.1.295 source described in
[the streaming contract](claude-incremental-streaming.md) forwards an API message
at offset 217692096; its SDK event definition at offset 207538778 leaves that
nested event opaque. Those observations do not establish another accepted header
field. This change therefore preserves the existing accepted keys and values.

`claude_stream_diagnostic.py` is a standalone, dependency-free projection helper.
It performs no I/O and installs no diagnostic transport or automatic logging.
A separately reviewed, authenticated collector can path-load its exact pinned
file without changing import search paths. Its caller must provide the nested
message from an already decoded, bounded JSON frame, rather than traceback locals
or arbitrary provider objects.

`message_header_shape(message)` emits exactly six fields:

| Field | Closed meaning |
| --- | --- |
| `version` | Integer `1` |
| `kind` | `not_object`, `missing_required`, `extra_fields`, or `closed_keys` |
| `required_mask` | Bits 0–2: `id`, `role`, `content` |
| `optional_mask` | Bits 0–9: `type`, `model`, `stop_reason`, `stop_sequence`, `usage`, `container`, `context_management`, `stop_details`, `diagnostics`, `resumable` |
| `extra_count` | Number of other keys, saturated at 64 |
| `extra_overflow` | Boolean indicating more than 64 other keys |

Missing required keys take precedence in `kind`; the masks and extra count still
distinguish a simultaneous missing/extra failure. `not_object` has zero masks and
counts. Only exact dictionaries produced by JSON decoding are inspected. The
projection uses fixed key membership checks and the object length; it never
reads field values, iterates unknown names, emits arbitrary names or hashes them.
The parser imports the same ordered constants to prevent diagnostic drift.

`valid_header_shape(value)` validates only this closed projection schema, including
exact scalar types, ranges and consistency. `closed_keys` is not a valid-message
claim: a header with the wrong role or invalid content can have the same masks as
a valid one. Neither function grants Progress, terminal, Stop, acceptance or
resume authority, nor does a projection prove which native process produced it.
Collector peer authentication, frame limits, record/byte limits, custody and
explicit activation remain separate obligations. A non-header frame should have
no projection; callers must not manufacture a header from unrelated data.

Run the focused privacy and refusal checks from `v2/provider-broker`:

```sh
python3 -B -m unittest test_claude_stream_diagnostic -v
python3 -B -m unittest discover -p 'test_claude*.py' -v
```

The tests cover each required and optional bit, simultaneous failures, saturated
counts, values whose inspection would fail, absent key/value leakage, strict
collector validation, unchanged parser refusal, and standalone exact-path import.
This is diagnostic support only; it does not repair an unidentified native header
variant or qualify an actual provider execution.
