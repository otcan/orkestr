# Mounted timer lifecycle source review

Exact source: `57ab9b1c8b5e09e3cfcbe403ea10015dfda5b7db`, compared with native identity predecessor `9d8116216`. No blocking finding in the bounded registration/lifecycle review.

The leaf router is merged before the existing Origin/browser guard and response cache policy. It carries the credential selected by shared owner authentication into Store transaction-time checks; HTTP cannot select a clock, authority or scheduler tick. Browser writes retain cookie/CSRF enforcement; Origin-free machine authentication follows existing shared policy. Unknown query/body fields are rejected by the leaf DTOs.

AppState retains one shared controller instance used by both routes and the ordinary server task. Main starts that task after configuration/static setup and joins shutdown explicitly. Each pass is bounded to five seconds, with missed interval ticks skipped; shutdown waits six seconds, then aborts and joins on timeout and reports failure. Ordinary restart creates an empty ephemeral grant map.

The controller retains at most 32 owner/namespace grants, each bound to a durable generation, credential, explicit text and monotonic one-hour expiry. Current authentication and durable state/generation are checked for delivery. Exact Enable receipt replay does not insert, renew or reconstruct a grant. Fresh disable/enable is required after restart or expiry. Disable/Stop/rollback persist through the Store before local disarming. A pending due input is ordinary durable intake, not a fabricated provider run or readiness grant.

Reviewed supplied lifecycle test setup and oracle: SQLite backup captures the synthetic seed including WAL, the owned binary receives synthetic sessions only, natural due delivery is checked, normal shutdown must return zero, restart stays unarmed, old Enable replay remains inert, fresh transition re-arms, and queued projection has no run/control authority. This review did not execute that test or rebuild/relabel its supplied binary.

Author mounted/Core tests and supplied actual-binary results remain author evidence. One-hour real-duration behavior, durable schema-33 authority, provider execution and production qualification remain separate gates.
