# Codex assistant output snapshots

Core Progress payloads are immutable snapshots. Execution status and accepted
history select the latest snapshot before the completion proposal; they do not
concatenate provider deltas. The Codex adapter therefore retains assistant item
identity, phase, and text until the correlated turn ends.

The broker forwards only bounded `agentMessage` item metadata, delta identity,
and the assistant part of the terminal turn summary. Other tool items do not
acquire execution authority. Rust validates matching thread/turn/item identity,
completed text against streamed fragments, and any supplied terminal summary.
Known phases are `commentary`, `partial_answer`, and `final_answer`. A single
declared final item is selected again before CompletedProposal, even when later
commentary was displayed. Explicit commentary alone cannot become an answer.

Missing phase remains a legacy compatibility case: the last completed unknown
phase item with non-whitespace text is selected if no final item exists. This
matches the native terminal-summary selection; later whitespace-only items do
not replace an answer. Legacy streams without item
lifecycle use their last message's accumulated text; missing item IDs are
accepted only when there is a single unambiguous open item. Completed-only
items are supported. Distinct items are never concatenated. Multiple final
items, changed completion text, replay, unfinished lifecycle, or conflicting
correlation refuse the stream. Interrupted/failed turns retain their existing
terminal rules; text never supplies cancellation or acceptance authority.

Each turn retains at most 128 assistant items, each at most 8192 UTF-8 bytes
(the existing Progress payload limit). Live snapshots emit at geometric byte
thresholds, beginning with the first nonempty fragment; each next threshold is
twice the last emitted size. Exact item completion and final selection bypass
that threshold, with duplicate snapshots suppressed. Snapshot text storage is
less than four times retained item text, at most 4 MiB per turn, rather than
growing quadratically with one-token fragments. Metadata/event overhead is
additional and remains subject to existing transport/window budgets. Existing
frame, queue, lease, dispatch, and acceptance boundaries remain authoritative.

The native 0.163 schema permits null/absent phase for legacy models. Its terminal
notifications contain either a last-message `summary` or `notLoaded` items;
supplied summaries must agree with already completed assistant items. This
compatibility does not infer final-answer phase from prose or concatenate
commentary into the selected answer.
