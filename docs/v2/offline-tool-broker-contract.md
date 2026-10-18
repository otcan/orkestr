# Offline Python broker contract

Status: unregistered wire validators only. No dynamic tool is advertised by the
current broker, and this document does not authorize provider requests or tool
execution. Runtime agreement and the Core-issued Worker/tool authority remain
prerequisites for wiring.

The proposed trusted launcher profile opts into exactly one experimental
`dynamicTools` function, `orkestr_offline_python`. Its arguments are exactly
`{"source": "..."}`: nonempty UTF-8 text, at most 32768 bytes, without NUL.
The schema rejects additional properties. Client role JSON cannot enable this
profile or establish Worker admission. Built-in shell and generic provider
request forwarding remain refused.

`offline_tool.py` validates `item/tool/call` against the currently issued native
thread and turn identities. The parameters contain only arguments, callId,
threadId, turnId and tool, with namespace absent or null. The request ID is a
UTF-8 string of 1–128 bytes without Unicode control characters, or an integer
from 1 through 2^53−1 (booleans are refused), matching Core’s native request ID
boundary. Validation returns a fresh wire
object, never an execution grant.

Runtime must own the sealed pending request, permit at most one outstanding
call, reject duplicate request/call IDs and retired-turn output, and require
Core's current Worker lineage and one-use offline tool delegation before the
server dispatcher invokes the reviewed offline sandbox. Neither a parent turn
grant nor a provider tool request substitutes for tool authority. Stop,
revocation, expiry and ambiguous delivery must quarantine results as required by
the durable ledger; no automatic retry or delegation replacement is permitted.

The proposed result is exactly a matching native request ID and
`result:{contentItems:[{type:"inputText",text}],success}`. There is exactly one
text item, at most 8192 UTF-8 bytes, and success is a boolean. No image, audio,
URL, command, path or environment extension is admitted. Runtime derives this
result from the sealed dispatch outcome, not caller-supplied arbitrary bytes.

The agreed outer envelope is
`{id:<fresh outer>,method:"ToolResult",params:{owned_handle,frame:<native result>}}`.
`BrokerPrepared` uses that fresh outer ID and exact owned handle. The inner frame
retains the pending native request ID; no replacement native ID is allocated.
`validate_submission` checks this closed shape only. Runtime owns monotonic outer
IDs, pending-call/turn/child lineage and duplicate history. Routing remains
unregistered pending Core's completed-result capability and dedicated current
delivery fence. Preparation grants no authority.

Python must never write or queue the native result:
Runtime retains the sole provider stdin writer and performs every bounded
suffix under the exact current purpose-specific Core fence. Waiting for native
acknowledgements stays outside SQLite callbacks. A partial/uncertain write is
not retried under another authority.

Evidence: local pinned native protocol schemas contain DynamicToolSpec,
DynamicToolCallParams and DynamicToolCallResponse. The validators intentionally
admit a smaller text-only subset. Synthetic unit tests exercise only these
validators; ordinary Worker admission, native tool invocation, sandbox dispatch,
Stop races and actual provider result acceptance are unexecuted in this slice.
