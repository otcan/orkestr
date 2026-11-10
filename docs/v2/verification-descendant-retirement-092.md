# Descendant retirement source review

Reviewed exact Core `09220838c353fc4143d0c5a0e3914885300edb87`, atop schema 37. No bounded source blocker found. This is independent source review only; no Rust tests, native processes or server composition were executed for this review.

The same read-only negative guard runs before retirement provenance writes, candidate disclosure, and immediate-transaction reattach. Existing current-authentication, canonical accepted/Stopped run evidence, binding generation and predecessor CAS checks remain in place.

The guard refuses queued or claimed tasks and residual claim hashes. Historical held/delegated task rows remain inert. Never-admitted grants require blocked state with erased locator; admitted grants require their exact linked canonical terminal Worker run. Confirmed Worker readiness without a terminal run at the released binding generation refuses, including Lost bindings.

Tools require committed completed/failed output evidence or cancellation plus canonical Stopped parent evidence. Native results independently require delivered state and nonzero written bytes. The sealed finish writer checks unpoisoned capability, full frame length equal to its offset, and current committed byte accounting before setting delivered. Pending control outbox rows also refuse. These checks neither repair rows nor promote unknown effects.

Inspected all six new test functions: accepted/Stopped descendants with retained held tasks; unresolved child states; confirmed unadmitted setup; native result delivery stages and post-retirement drift; tool outcomes/cancellation; residual claims and live grant locators. Refusal snapshots and candidate/reattach drift checks provide useful issuing-crate coverage. Supplied synthetic callbacks and mutation probes do not establish actual native delivery or reap. Author-reported 31 terminal tests and lint results remain author evidence, not independently rerun results.

Server qualification still requires a zero-new-dispatch freeze and the original Runtime reap witness for the parent and every actually launched Worker, including metadata/setup-only children. Database rows, expiry, empty child collections and caller booleans cannot substitute for those witnesses. No process, provider or restart qualification follows from this source gate.
