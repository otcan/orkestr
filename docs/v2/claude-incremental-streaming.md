# Bounded Claude partial text

The selected Claude broker requests `--include-partial-messages` explicitly.
`ClaudeTextStream` converts each validated text delta into the existing sanitized
assistant frame, so Runtime can observe Progress before a complete text block.
It grants no input, execution, Stop, acceptance, or resume authority. Those
operations still require their existing Core and Runtime capabilities.

## Source and correlation

This leaf was checked against Claude Code 2.1.295, executable SHA-256
`4503bfe11a6c7fcc1e0b39b5e0d347c04248f750b03b0977b3ad6b531fe6f358`.
Relevant byte offsets in that pinned executable are:

| Offset | Observation |
| --- | --- |
| 207647582 | SDK partial-event envelope and API message identity |
| 241528408 | Independent first stream and first assistant input echoes |
| 217692096 | Ordered response/block streaming |
| 217696372 | Complete assistant emitted before its raw block stop |
| 217687658 | Interrupted stream closure before its message stop |
| 241364847 | API message identity mapped into the SDK envelope |
| 222687468 | Result text selected from the last assistant text block |

This is a deliberately restricted adapter for one selected child, one submitted
input in that child lifetime, and one API response. The first non-ping partial
event must be `message_start` with the exact native session, explicit current
input echo, and matching API message identity. Every following non-ping event
must retain that API identity. No status, text content, earlier assistant, or
historical transcript can supply a missing stream anchor.

The first full assistant must independently echo the current input. Later full
blocks must retain its API/model/request identity. Complete assistants must
arrive in block order, before their own block stops. The text byte length and
SHA-256 must match the deltas already delivered. The complete block then emits
nothing. A successful result must repeat the verified last text block after a
complete stream; its duplicate text becomes empty while its original correlated
terminal envelope continues through the existing result codec. Neither a text
hash nor a raw message stop establishes execution completion by itself.

## Bounds and failure behavior

| Resource | Hard bound per submitted input |
| --- | --- |
| Text delta | 8,192 UTF-8 bytes |
| Aggregate streamed text | 32,768 UTF-8 bytes |
| Partial/full/result events, including pings | 1,024 unique event UUIDs |
| Content blocks | 128 |
| Discarded thinking/signature/redacted content | 262,144 UTF-8 bytes, including repeated full blocks |
| Original native wire after input admission | 1,048,576 bytes, including newlines and whitespace |
| Individual native JSON line | 65,536 bytes before its newline |

`ClaudePump` subclasses the existing transport without changing launch, writer
handoff, queue limits, or reaping. Its native-line entry supplies the original
wire length to `ClaudeChannel.provider`. Production compositions must use this
subclass, including isolated selected launchers. Direct decoded-object unit
calls use canonical JSON length and cannot prove the original wire budget.
The transport's existing eight-frame queue bound remains unchanged.

Thinking, signatures, and redacted data are validated and discarded. They are
never placed in the output queue, retained as text, or hashed into stream state.
Only text blocks retain a rolling digest and length. Raw JSON necessarily exists
briefly while a frame is decoded and validated.

After an exact cancel request, later text is still validated and bounded but
not emitted. An interrupt acknowledgement alone never becomes a stopped result.
Only the existing correlated `aborted_streaming` terminal path can produce the
Stop observation. A genuine interrupted terminal can close an unfinished text
block. Cancellation does not expand any byte/event budget. The older bounded,
discard-only cancellation notice path remains available before a stream anchor;
such a notice cannot authorize a subsequent partial stream or any Progress.

Foreign scope, reused event UUIDs, changed API/model/request identity, replay,
unexpected order, mismatched full/result text, unknown fields, tool/citation
events, and exhausted budgets poison the channel. No later valid frame revives
it. Retried API responses, joined text runs, plugin-rewritten events, missing API
identity, or unsupported metadata remain unavailable. The adapter does not
silently relabel those cases as successful output or stopped execution.

## Composition and verification

`claude-package.json` includes the stream/schema/pump modules and their hashes.
The generic connector opts in on both fresh and resumed launches. The separate
selected isolation argv change is dependency
`b5b179a3917519858b459a03d620c3ec0001264e`: the reviewed backport of
`afac2532ff1060dfddcd4f1ee360406558e4725d` onto the existing selected-account
lineage. Apply its full reviewed twelve-module isolation closure; this leaf
does not add an incomplete package or import unrelated authentication changes.

Run from `v2/provider-broker`:

```sh
python3 -B -m unittest discover -p 'test_claude*.py' -v
```

`test_claude_streaming.py::Frames` provides canonical synthetic envelope/order
examples. `test_claude_stream_rejections.py` tests attribution, ordering, byte and
event caps, poisoning, discard-only thinking, and cancellation boundaries.
`test_claude_stream_process.py` launches only the owned synthetic fixture,
receives its writer through FD3, observes text before releasing the full block,
and verifies exact child cleanup on completion and interruption. It proves the
broker process/parser path, not authenticated HTTP Stop or real-provider
behavior. Real provider qualification and a separately reviewed selected
package remain required; no account was activated for this leaf.
