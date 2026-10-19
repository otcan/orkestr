# Durable timer read compatibility

UI successor matches the read mapping at PR111 source `3c8841789804bd20ce1153050a4a2984d7daf6d6`. Routes and request tuples are unchanged. Adoption remains subject to that mounted backend's independent review and matching candidate integration.

An enabled timer with `scheduler_unavailable` displays saved permission with scheduling unavailable; it does not tell the owner to replace a valid grant. `durable_owner_enable_required` requests disable followed by fresh owner instructions. Armed status reports scheduling availability, never work completion. Unknown holds fail validation. Armed responses with a hold remain invalid.

The obsolete unconditional one-hour/restart notice is removed. The legacy `explicit_owner_rearm_required` response retains its legacy guidance, so an older server does not acquire durable-continuity claims from this UI. Missing hold data remains unavailable without guessing a grant. No browser authentication, uncertain retry tuple, conflict review or owner fencing changes are made.

Focused timer reducer/labels: 11 tests passed. A matching backend/browser pair, independent mount review, multi-day operation and mid-transaction crash coverage remain separate gates. No bundle is produced by this change.
