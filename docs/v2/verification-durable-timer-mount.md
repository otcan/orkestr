# Durable timer mount source and artifact review

Reviewed PR111 `3c8841789804bd20ce1153050a4a2984d7daf6d6`, executable source `fb5a31fa55e342a3189e8f03c8f5ffa82b49cb2d`, relative to 25b3. No blocking source finding for this bounded mount. The evidence successor changes documentation only; manifests and lock are unchanged.

The trusted local bootstrap accepts only strict configuration and canonical private regular singly-linked files, verifies opened inode/owner/mode, bounds reads, and passes the credential to Core's current-auth timer-only bootstrap. Provider readiness is fenced for that reserved context. Live predecessor bootstrap refuses; graceful release and real lease expiry permit a new incarnation without reviving revoked authentication. Startup and hourly renewal require current auth and live context; renewal is service-specific and bounded forward twelve hours per call, not a maximum total service lifetime.

Owner enable/read retain shared auth/Origin/CSRF and exact credential transaction checks. Durable authority is read from the current generation/Stop watermark, not browser credential caching. Each bounded discovery page obtains fresh issuers and uses Store time and duplicate-aware atomic intake. Disable/replay cannot recreate authority. Scheduler failure clears availability and triggers ordinary server shutdown. SIGTERM/SIGINT initiate HTTP shutdown, join the current bounded scheduler pass, retire its exact context, then join execution cleanup. A shutdown request does not interrupt an in-flight pass: up to its five-second bound may elapse before quiescence. Availability is process-local sampled state, not independent proof that a particular future occurrence will succeed.

## Artifact and receipt verification

Independently rehashed the supplied executable: SHA256 `8d0e27247c53029c55b6246b8c91d497df840aaf9308a0aa6dfab8159d0e8980`, matching the requested pin. Independently compared all 48 receipt file hashes with exact executable-source git objects: all match. Receipt SHA256 is `a1bed5063c1b75b52854e7c0381bbd033167921cb3ba9af15e8059bfe8c0cd5c`.

The private artifact/receipt directory is `durable-mount-fb5a31fa55e342a3189e8f03c8f5ffa82b49cb2d` under the Migration review state directory. The receipt summarizes author server timer9, process1 in70.04s, lifecycle3 and strict lint/format results. **No raw process log was retained**, as the author explicitly confirmed. This source/receipt review does not independently establish those execution counts; no build, executable invocation or process rerun was performed.

The inspected process oracle uses actual elapsed time and synthetic ordinary HTTP/SQLite state: creator logout, due intake, disabled occurrence exclusion, weekly schedule continuity across restart, inert historical enable replay, changed retry conflict, kill after committed intake/new exec after real lease expiry, and machine revocation terminating the server. It verifies zero provider runs. It does not kill inside an admission transaction. Prior generic-bootstrap restart and SQLx test-compilation failures remain preserved in the author document. No multi-day elapsed-runtime, packaging/schema33 installation, real provider, browser or production qualification follows.

## Matching UI wording successor

Independently source-reviewed selective UI commit `fddd4a4044110fade4bf1d6ad7ea26074a84a98a`: no blocking source finding. Its three accepted hold values match the mounted read contract. `scheduler_unavailable` describes saved permission without prescribing a replacement grant; `durable_owner_enable_required` requests fresh owner instructions through disable/enable; the legacy explicit rearm hold retains legacy guidance. The unconditional one-hour/restart statement is removed. Availability still explicitly does not confirm execution.

Validation rejects unknown holds and any armed response carrying a hold. Existing scope/state validation and uncertain mutation retry behavior are unchanged. Inspected supplied label and reducer cases cover these distinctions; they were not independently executed in this source-only review. The author's eleven focused tests and WASM check remain separately attributed. No new bundle, matching browser execution, multi-day continuity or transaction-crash qualification follows.

## Independent mounted process replay

Independently executed the supplied ordinary lifecycle case against the copied
immutable `fb5a31fa55e342a3189e8f03c8f5ffa82b49cb2d` artifact: **1 passed,
zero failed/ignored, 70.01 seconds**. Binary hash again matched
`8d0e27247c53029c55b6246b8c91d497df840aaf9308a0aa6dfab8159d0e8980`.

Used an exact source archive. Registered the supplied Rust seed parent as a
private Store integration test, replacing only its two compile-time script/binary
paths with the copied exact artifacts. Setup, public Store imports, all assertions
and Python source were unchanged. Required-wrapper offline locked invocation
compiled only the Store fixture; no server rebuild or shared workspace edit.

The case exercised current cookie/Origin/CSRF, natural due intake, creator logout,
weekly schedule restart without waiting a week, disable-before-due, inert exact
replay and changed replay conflict, actual SIGKILL after committed intake, new exec
after real supervisor expiry with no duplicate intake, and machine revocation
terminating the server. It asserts one intake, zero native runs, schema33 and clean
foreign keys. Its finally cleanup ran; no matching test/server processes remained.

Raw Cargo/Rust test output and an independently generated receipt remain private;
receipt SHA256 `349ac6bb29c22aff2a9eb319662f08a768f05d3b343fd06a973cc55853322d65`.
The unchanged parent captures and discards successful Python JSON stdout, so no
separate child stdout transcript is claimed. The initial direct Python invocation
failed argument unpacking before server launch; that raw failure remains preserved.

This supersedes only the earlier lack of independent process execution. It adds
no mid-transaction crash, multi-day, packaging, real-provider or browser credit.
The separate exact23b Claude lifecycle independent four-case pass is retained and
was not repeated.
