# Explicit Worker time limits

Uses the reviewed Core36 request at `c534ab15abe7fb3ff973263f6cf75b6ed3697ed9`, consumed in provenance commit `57ca50919`. UI-only successor; no backend policy, shared server, root manifest, lock or paired artifact changes.

Time limit defaults to 30 seconds with `execution_budget_ms` omitted. The owner may explicitly select one, five or fifteen minutes. Each selection maps to a bounded typed value. `lifetime_ms` remains 30000 in every request; this initial lease is distinct from the requested total execution budget. Unknown choices refuse without changing the draft. Host/parent policy may shorten the effective persisted deadline, and the UI never infers that deadline by adding the requested budget to a timestamp.

The retained owner/session/conversation/parent draft includes the choice. Uncertain retry freezes the original budget with text/key/parent/control revision, even when the owner selects a different next-task limit. A visible original-request notice distinguishes the frozen tuple from next-task edits. A matching successful response resets the choice to default only if the draft revision is unchanged; later edits survive. Existing logout clearing and remount storage apply to this field as well.

Current WorkerTaskReceipt, WorkerTaskStatus and ExecutionStatus expose no effective deadline. History explicitly reports that limitation and links to actual worker activity. No client deadline or host permission is fabricated. A future reviewed read field can supply the effective deadline separately.

Focused validation: six Worker reducer tests and two actual VirtualDom lifetime tests, including budget retention through component unmount/remount and distinct draft/original budget, passed. Locked offline web+execution-controls WASM build and strict Clippy passed. Matching ordinary HTTP/browser selection, retry and effective-policy evidence remains a later paired candidate gate; server/provider evidence is not transferred to this UI.
