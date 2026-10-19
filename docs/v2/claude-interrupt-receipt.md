# Claude interrupt receipt metadata

The broker accepts the optional `still_queued: []` field beside the required
`turn: "stopped"` in a successful, exactly correlated interrupt reply. It
discards the empty list and emits the same sanitized ACK as before. A missing
list remains compatible with the earlier sanitized reply shape.

This is limited to the existing one-input native channel. Nonempty lists,
non-list values, unknown fields, `send_now`, and `cancelled` are refused. The
request ID, success subtype, stopped verdict, and absence of pending permission
or dialog requests remain required. These fields cannot supply input admission,
queue-release, cancellation, terminal, or process-reaping authority.

## Source evidence

The inspected Claude Code 2.1.295 executable has SHA-256
`4503bfe11a6c7fcc1e0b39b5e0d347c04248f750b03b0977b3ad6b531fe6f358`.
Its embedded source contains the following byte offsets:

- The interrupt reply schema at `207780133` requires `still_queued` and defines
  the optional scoped `turn` verdict.
- The local stdio interrupt handler at `241741713` derives the requested input
  scope, then calls the receipt constructor at `241742166`.
- That constructor includes `still_queued` on the plain-interrupt path at
  `241395838`, then adds `turn` when the request names input UUIDs.
- The local writer at `241734886` passes this receipt unchanged to the success
  response constructor at `210897538`.

The previous `exact(payload, ("turn",))` check rejected this source-supported
reply even when the survivor list was empty. This proves a compatibility gap.
It does not identify the unretained field or caller in a prior live refusal.

## Evidence boundary

An ACK still records only request handling. A separate, exact-session and
exact-input `aborted_streaming` terminal is required, and Runtime must obtain
the original owned process-tree reaping witness before durable Stopped. No
Runtime or Core authority path changes in this leaf.

The focused regression uses the same native-shaped reply before and after the
fix. It checks unchanged outer ACK bytes, both terminal/ACK orders, ACK-only
noncompletion, reply replay, malformed and nonempty survivor lists, alternate
interrupt modes, foreign correlation, and missing terminal evidence. The owned
synthetic FD3 process fixture now includes the native survivor list; the test
observes an ACK while the child is still alive, requires the later genuine
terminal, and verifies owned child cleanup.

```sh
cd v2/provider-broker
python3 -B -m unittest -v test_claude_interrupt_receipt test_claude_stream_process
```
