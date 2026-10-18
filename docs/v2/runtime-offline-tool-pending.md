# Pending offline Python call decoder

`broker/offline_tool.rs` is intentionally unregistered. Its scoped test composition
uses full Core `41309628e` including the shared request-ID enum from
`256449100fbb4882bb9a6675a3c9714310183fb7`. It has no native routing, tool
advertisement, sandbox invocation, inference authority, or result writer.

The private decoder accepts exactly `item/tool/call` for
`orkestr_offline_python`, the current native thread and turn, one bounded call ID,
and `{source: string}` only (1..32768 UTF-8 bytes, no NUL). Namespace may be absent
or null. Request IDs preserve Core's Text/Integer distinction and validity bounds.
The pending value has no public constructor, Clone, Debug or serialization; its
read-only getters expose correlation/source, and private Arc identity binds it
to the actual local child. Correlation does not authorize tool execution.

Integration must occur only in the trusted fixed-tool Worker profile. The owned
channel must enforce one outstanding call and bounded replay history, reject
malformed/duplicate wire keys before losing that information, and retain the
exact pending value until a Core-issued result delivery is consumed or the child
is quarantined. Core computes the source digest from the exact retained source.
Do not construct result authority from these getters or a sandbox receipt.

The agreed result wire is `ToolResult` with a fresh outer ID, exact owned handle,
and native frame `{id: original_request_id, result: {contentItems:
[{type: "inputText", text: bounded_text}], success: bool}}`. BrokerPrepared
correlates the outer ID. The broker never writes provider stdin. Core's pending
0032 delivery ledger/fence must authorize every actual bounded suffix; registration
and result writing remain unavailable until that source and composition pass review.

The disposable composition retains byte-identical lane manifests/lock and adds
only a temporary private module registration. Three focused decoder tests pass:
exact identity/source/lineage and ID kind, foreign identity/tool/extra-claim
refusal, and UTF-8/request-ID bounds. No provider or sandbox process is launched.
