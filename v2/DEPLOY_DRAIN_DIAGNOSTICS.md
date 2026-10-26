# Deploy drain predicate diagnostics

`deploy-drain.status.json` retains its existing drain decision and adds a bounded `diagnostics` observation. `orkestr-v2-train status` already includes this file.

Each entry identifies its conversation and, when Core still reports an unresolved window, its window ID, generation and age. `local_roles_ready` records the existing native-role check. `core_switch_ready` is null when that check was not reached; false and unavailable remain distinct outcomes. Retirement and cleanup outcomes use fixed labels, never provider text, prompts or credentials.

`observed_ms` timestamps the diagnostic pass independently of the status-file write time. `total` is the complete entry count; `windows` retains at most 64 entries. A retired window can have no current Core window identity because it has already left the unresolved listing.

This is observation only. The operation lock, predicate short circuit, authenticated store reads, clean-stop/custody protocol and queue preservation remain unchanged. `drained` still depends on the existing authenticated unresolved count, and diagnostics cannot change that result. No sealing mechanism, admission change, timeout exception or new provider call is introduced.
