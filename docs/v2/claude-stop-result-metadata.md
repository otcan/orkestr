# Closed Claude Stop result metadata

The pinned native stream producer carries `terminal_reason` from the aborted
stream generator into the error result, then adds the consumed input echo in
the headless adapter. The SDK error-result schema also includes queue count,
result index, safety count, optional subagent statistics and fast-mode metadata.
Its dispatcher assigns a queue count before emitting the result. Rejecting that
metadata prevented an otherwise valid interrupted result from reaching the
existing Stop checks.

The broker now validates and discards only those known metadata fields plus the
producer's parent-tool/timestamp envelope and human origin. Its no-tools,
single-input contract requires no native queue, no parent tool, and entirely
zero subagent counters. It checks the complete original byte bound before
discarding. Unknown fields, malformed metadata, tools, peer origins and automatic
resume markers remain refused.

The helper supplies no missing authoritative field. Exact native session and
consumed input, a fresh terminal UUID, `error_during_execution`, `is_error=true`,
and `terminal_reason=aborted_streaming` are still required by the unchanged
control validator. Acknowledgement is separate; the server still requires owned
tree reaping before durable Stopped. ACK-only, process exit, other terminal
reasons and metadata alone cannot confirm Stop.
