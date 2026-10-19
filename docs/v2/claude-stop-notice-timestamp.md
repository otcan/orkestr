# Claude interrupted user-notice timestamp

Claude Code 2.1.295 includes a timestamp on the user notice emitted when a
no-tools stream is interrupted. The broker previously rejected this display
field before discarding the notice. It now accepts only an optional, valid
calendar timestamp shaped as `YYYY-MM-DDTHH:MM:SS.sssZ` on a user notice during
an already issued cancellation. The timestamp is never forwarded or compared
with a local clock. It cannot acknowledge Stop or supply terminal/reap evidence.

The inspected native executable has SHA-256
`4503bfe11a6c7fcc1e0b39b5e0d347c04248f750b03b0977b3ad6b531fe6f358`.
These offsets describe static producer source, not captured provider frames:

| Byte offset | Source evidence |
| --- | --- |
| 219210408 | `xe` supplies the user-message timestamp from the supplied clock or `Date.toISOString()`. |
| 219212252 | `hx` creates the interrupted text notice through `xe`, without tool output, origin, virtual or refusal metadata. |
| 219214187 | `gf` and its user normalization preserve that timestamp and the existing optional provenance fields. |
| 222674409 | `VQe` emits synthetic metadata only when the internal meta/visibility/summary flags are set. |
| 222689823 | The ordinary `Mie` user serializer includes the normalized timestamp. |

The current session, optional exact input echo, canonical unique event UUID,
no-tools content, 16 KiB original frame bound, 128-notice limit and overall
channel byte limit remain unchanged. Assistant timestamps do not gain a new
notice path. Malformed dates, unknown fields, tool metadata, foreign identities
and replay still refuse. No notice is accepted after the terminal.

The same source audit checked the remaining Stop envelope paths. `E7` at
207486773 and the ordinary result construction at 223641557 use the existing
closed result metadata handling. Interrupt ACK queue metadata remains separately
validated. Input-intent extensions such as `priority` and `shouldQuery`, SDK
`interrupted_message_id`, tool/refusal metadata and virtual messages remain
outside this notice contract. None is added speculatively.

A real diagnostic observed a current-session user frame failing the old
top-level allowlist, but did not record the extra key's identity. The timestamp
gap is confirmed by the pinned source and a synthetic reproduction at that
exact guard; it is not a confirmed attribution of the real failure. This leaf
does not claim successful real Stop, process cleanup or production activation.

Focused synthetic validation:

```sh
cd v2/provider-broker
python3 -B -m unittest test_claude_notice_timestamp test_claude_control \
  test_claude_stop_metadata test_claude_interrupt_receipt -v
```
