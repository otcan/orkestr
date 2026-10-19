# Interrupted Claude text envelopes

Claude Code 2.1.295 emits `aborted: true` on the full assistant text block
preserved when an interrupt truncates its active stream. The broker previously
rejected this key even after accepting the current input's cancel request.

The source inspected is executable SHA-256
`4503bfe11a6c7fcc1e0b39b5e0d347c04248f750b03b0977b3ad6b531fe6f358`:

| Byte offset | Source evidence |
| --- | --- |
| 207574387 | SDK `aborted` is optional literal `true`, describing incomplete interrupted text with no received stop reason. |
| 217688783 | The partial-text abort constructor sets `isAbortedMidStream: true`. |
| 222679197 | `Io` maps that flag to `aborted: true`; absent flags remain omitted. |
| 222689823 | The ordinary root assistant constructor `Mie` includes `Io` metadata. |

The new path accepts this one flag only after the owned channel has accepted
the exact current-input cancel request. It still requires an anchored stream,
one text block, absent/null `stop_reason`, the same native/API/model/request
identities, a fresh event UUID, correct block order, and byte-for-byte equality
with the streamed text. All existing frame, event, block, text and wire limits
remain in force. `false`, truthy non-booleans, unanchored or ordinary output,
foreign scope, API errors, history, tools, extra fields and nested unsupported
metadata still refuse and poison the channel.

The full block produces no output. The flag neither acknowledges an interrupt
nor proves its terminal result or child cleanup. Only the existing independently
correlated native terminal can supply the interrupted observation; Core Stop,
acceptance and reaping requirements are unchanged.

An actual diagnostic retained an extra-key assistant-envelope refusal with all
required keys present, but did not retain the extra key's identity. This leaf
repairs a gap established by pinned source and synthetic reproduction. It does
not identify that diagnostic's offending key or qualify another provider run.

The focused tests use only synthetic frames and an owned synthetic child over
the existing sole-writer FD3 path. The unchanged parser rejects the
source-shaped abort fixture; the corrected parser discards it, waits for a
separate terminal, and joins the exact child. No account or real provider is
used:

```sh
cd v2/provider-broker
python3 -B -m unittest test_claude_aborted_assistant test_claude_stream_process -v
python3 -B -m unittest discover -p 'test_claude*.py' -v
```
