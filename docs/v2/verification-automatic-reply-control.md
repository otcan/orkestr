# Automatic reply permission control review

Independent source review covers Core `d8b86f5e2180df98144d14e101a1ad89a7a90f31` and isolated HTTP leaf `32055a68592cc3cca20d1f156278995486a18df5`. No bounded source blocker found. No independent execution or canonical mounting credit is claimed.

The read authenticates the original credential and conversation owner in the same read transaction, refuses bound machine handles, and returns only sampled policy. Limits are 1..32, nonnil exclusive UUID cursors, with limit-plus-one pagination. Pages are separate cuts, not a coherent retained list. The structural validator does not bind the requested cursor; consumers must retain that binding.

Mutation authenticates the original credential under BEGIN IMMEDIATE before receipt lookup or writes. Exact historical receipts remain immutable across trusted route replacement; changed request content conflicts. Current authentication and conversation/route scope are still required for replay. A historical receipt never establishes current enabled policy.

The HTTP leaf rejects Bearer or mixed credentials through the existing browser helper, preserves the namespaced cookie credential for Store authentication, and checks Host during browser preflight. POST additionally invokes the existing Origin/CSRF guard inside the handler. Query deserialization denies unknown/duplicate fields; Store enforces cursor/limit bounds. POST accepts no query fields and has a 2048-byte body limit. Missing/foreign conversation coalesces to Unauthorized; missing route maps to NotFound. The supplied actual HTTP test inspects these behaviors, pagination, replacement/replay and revocation; its reported pass remains author evidence.

Coordinator must register the module and nest the router inside the canonical browser guard under `/api/v2`, preserving no-store/nosniff and existing outer policy. The leaf exposes no ingress, route issuance, producer, held-input release or transport endpoint. Permission enabled is policy only, never connector readiness or authority to send an arbitrary input.
