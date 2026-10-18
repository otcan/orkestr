# CI headless rendering

The dedicated `v2-browser.yml` workflow renders the actual release WASM bundle
against an owned temporary server and synthetic administrator on V2 branches.
It uses the existing locked Puppeteer dependency with lifecycle scripts disabled,
then explicitly installs its matching browser in the disposable CI runner.
No host desktop, persistent browser profile, production data or secrets are used.

Checks cover DOM boot, setup/login, HttpOnly SameSite cookie, durable message
receipt and history after reload, missing-CSRF refusal, confirmed logout, fresh password re-login with a new cookie, and
absence of browser Bearer authority. Browser runtime errors fail the job.
The workflow checks the exact candidate SHA, builds locked Rust dependencies and
uses the exact matching wasm-bindgen CLI. Only the existing reviewed checkout
action is used, with read-only permissions and credential persistence disabled.

This evidence must be reported as **CI headless rendering**. Authoring this job,
JavaScript syntax checks and workflow policy checks do not establish a browser
pass. Managed-desktop, interactive authentication, physical-device and native
iOS acceptance remain separate pending gates.

Worker branch pushes do not independently launch these checks. The Rust and
browser workflows filter `pull_request.branches` by **base branch** (`v2/**`),
not the candidate head branch. They therefore check exact heads targeting V2
branches; they do not currently cover a future promotion PR targeting `main`.
Push checks remain on `v2/rust-rewrite`.

`workflow_dispatch` is configured, but manual dispatch is not currently available:
GitHub requires the workflow file on the default branch, where these V2 files are
absent. Its configuration must not be reported as an available manual validation
path. Do not merge unfinished V2 work into `main` to enable it.

Before any future promotion PR targeting `main`, a separately reviewed workflow
change must explicitly cover that base branch with both locked Rust checks and
CI headless rendering. Verify that both jobs actually run and pass on the exact
promotion candidate, without a skip-as-success substitute. This is a promotion
prerequisite, not authorization to promote, release or deploy V2.

Per-workflow/per-PR concurrency cancels only superseded PR runs. Configured manual
and integration push runs use unique run IDs and are never cancelled by that
group. There are no skip-as-success conditions.
