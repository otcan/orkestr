# CI headless rendering

The dedicated `v2-browser.yml` workflow renders the actual release WASM bundle
against an owned temporary server and synthetic administrator on V2 branches.
It uses the existing locked Puppeteer dependency with lifecycle scripts disabled,
then explicitly installs its matching browser in the disposable CI runner.
No host desktop, persistent browser profile, production data or secrets are used.

Checks cover DOM boot, setup/login, HttpOnly SameSite cookie, durable message
receipt and history after reload, missing-CSRF refusal, confirmed logout and
absence of browser Bearer authority. Browser runtime errors fail the job.
The workflow checks the exact candidate SHA, builds locked Rust dependencies and
uses the exact matching wasm-bindgen CLI. Only the existing reviewed checkout
action is used, with read-only permissions and credential persistence disabled.

This evidence must be reported as **CI headless rendering**. Authoring this job,
JavaScript syntax checks and workflow policy checks do not establish a browser
pass. Managed-desktop, interactive authentication, physical-device and native
iOS acceptance remain separate pending gates.

Worker branch pushes do not independently launch these checks: each V2 pull
request checks its exact head. Push checks remain on `v2/rust-rewrite`, and
manual dispatch remains available. Per-workflow/per-PR concurrency cancels only
superseded PR runs; manual and integration push runs use unique run IDs and are
never cancelled by that group. There are no skip-as-success conditions.
