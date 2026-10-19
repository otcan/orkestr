# Independent steering UI review

Exact source: `bce459a89f549b9cc4d5890cc0b460dd9d3c4c65`.

Bounded source review: no blocker found. The steering DTO file imported by `6584ae247359ceb05fe28aee1affb306c450c50a` is byte-identical to Core `63366a487`.

New requests require validated Running status, steering capability, current monotonic freshness and a positive control revision. Pending uncertain requests preserve text, key, run and both revisions even when capability disappears; definitive refusals require explicit review before a new request. The component key includes conversation, run, session generation and selection generation. Async POST responses check those generations and component lifetime before applying state; teardown aborts the owned request. Delivery reads are fixed same-origin private GETs and bind the complete original receipt. Reserved, queued, unknown, acknowledgement and rejection labels do not claim completion.

Independently executed the six unchanged Node bridge tests exported from the exact commit: 6 passed, zero failed/skipped. They cover cookie/CSRF POST, path/method refusal, error handling, timeout/drop abort, bounded/malformed response handling and private GET. No Cargo/build, Rust reducer execution, browser lease or provider invocation performed. The four Rust tests remain author evidence. Matching server composition and mounted/browser/provider acceptance remain separate gates.
