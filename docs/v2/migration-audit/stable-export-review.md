# Stable conversation export: collector compatibility review

Reviewed exact commit `e975f5a1e5c9fb8e14cb8cd47859242efd9b7037`,
against Core `0bc3ffced736af222e4768f95f45f0d52d3518ae` and Migration
`76b50ab80fca1f9abac175fea71d4bf9b28e448b`. This is an independent source
review of the committed reader, split tests and documentation. No blocking
collector compatibility finding. Core retains registration acceptance; this
review grants no live export or importer authority.

| Collector requirement | Exact source implementation reviewed |
|---|---|
| Unchanged published fields, canonical UUIDs and scope | `conversation_export.rs::begin_conversation_export` constructs ConversationSnapshot/Message using published types and parsed UUIDs; Core contracts retain the same fields. |
| One conversation/scope/watermark | Capture reads scope/watermark and bounded messages under one read transaction; pages use the frozen receipt and materialized vector. |
| First cursor zero, then prior cursor, at most 100 messages | Handle starts next_after=0; page checks exact cursor and 1..100 limit, slices in ordered sequence and returns None only at end. |
| No later writes mixed into cut | SQL reads sequence>0 and <= frozen watermark; transaction closes before returning handle; no later row reads for page contents. |
| Current authorization | current_auth checks token hash, owner, conversation ownership and session expiry before/after capture and as final awaited page operation outside the cut. Revocation before that read refuses and releases. |
| Bounded complete collection | Rows<=100000; lifetime<=60s from capture start; cumulative delivered canonical bytes<=16MiB; at most1000 pages. Page/byte exhaustion refuses and discards the cut, never returns a truncated terminal success. |
| Canonical byte alignment | canonical_size counts serde JSON UTF-8 using ensure_ascii-equivalent widths, including DEL, BMP scalars and supplementary surrogate pairs. Compact serialization and key-order differences do not change length for these contract types. Each delivered page includes its envelope. |
| No lingering WAL pin | Capture commits and closes its close-on-drop pool connection; handle retains only private memory and pool. Read-only/trusted-schema settings cannot leak into a reused writer connection. |

Wrong token/owner/cut/cursor requests refuse without delivering data; not all
argument errors permanently invalidate a handle. Current-auth failure does.
This is compatible: the collector caller must abandon a partial collection on
any failure and release/drop its handle. A successfully completed handle cannot
be resumed. The receipt is private metadata, not a portable capability or proof
that the caller started at zero. Bind one collection to one handle/receipt;
never splice pages from separately captured cuts even if watermarks match.

The collector cannot verify authorization, cut identity, migration version or
source completeness from unchanged page bodies. Scope is historical while owner
access is current. This does not establish a multi-authority cut, legacy history
mapping, retention policy, dormant apply, rollback or release parity. Tokens,
receipts and actual message pages must remain private and unlogged.

Reviewed synthetic tests cover concurrent writers/frozen scope-watermark,
no-idle-WAL-pin, ownership/token/cut/cursor/release, current revocation,
project/empty conversations, expiry/row/serialized-byte limits, Unicode/control
escaping, repeated page envelopes and page-count exhaustion. The helper reports
eight Rust tests and strict lint/format passing; those checks were **not rerun**
in this LIGHT review. Actual Rust-to-Python collector wiring and its end-to-end
synthetic test remain **unexecuted**, pending Core registration in the combined
candidate. No Rust build, dependency download or live data read was performed.
Migration's existing Python suite was rerun separately: 85/85 PASS. It does not
execute this Rust module and is not evidence of completed cross-language wiring.

Next integration slice: Core registers the exact accepted reader; an authorized
synthetic integration harness serializes every returned page from one handle,
passes those pages to collect_pages, and compares the collected IDs/text/scope/
watermark to the expected pre-cut synthetic records. It must also prove that a
midstream refusal yields no retained successful export. Shared registration and
build admission remain outside this worker's scope. Dormant provenance/apply
requirements remain in dormant-provenance-contract.md, independently of this
read-only edge.
