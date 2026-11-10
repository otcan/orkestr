# Independent ordinary HTTP acceptance matrix

Implementation pin: `1633cd3516de98d50ea9f8c1c02690cb24b7d8d9`.
Register `acceptance/production_acceptance_http.rs` as
`apps/server/tests/independent_production_acceptance_http.rs` in a private exact
export and retain `acceptance/production_acceptance_http.py`. No manifest, lock
or implementation edits are needed. Use the required host wrapper, assigned
isolated target/home and owned listener port 47140. From the export's `v2`:

```sh
v2-cargo test --offline --locked -p orkestr-v2-server \
  --test independent_production_acceptance_http
v2-cargo clippy --offline --locked -p orkestr-v2-server \
  --test independent_production_acceptance_http -- -D warnings
```

One independently authored actual-HTTP test passed, zero failed/ignored, in
0.33 seconds. Selected strict clippy passed. Executable SHA256:
`1cb59f3876c9227b0dccdeb4809811890889b7ad403641036b636bb0351327a2`.

Public ordinary Store authorization/readiness/admission/reservation/consumption
uses synthetic native evidence, followed by Started and CompletedProposal.
An actual Axum listener serves the real router. Python receives synthetic
configuration through stdin under a cleared environment. There is no provider
process, fixture Store or private authority reconstruction.

Cookie absence, missing/invalid CSRF, missing/null/foreign Origin, wrong Host and
mixed Bearer reject on both acceptance and Stop. Stale Stop revision refuses
before effects. Acceptance checks forged run/completion, invalid key, spoofed
owner field, nonexistent conversation and changed revision/key. Every refusal
compares all rows of 16 execution tables through one query-only read transaction.
Success returns a linked receipt; retries after status refetch preserve the exact
receipt and ledger. Confirmed HTTP logout fences historical acceptance replay.
HTTP retry/refetch is not rendered browser or mounted approval interaction.

Candidate discovery is pending on this pin, which predates ec38's optional field.
The oracle validates an exact candidate if present, otherwise reports pending;
this run grants no candidate projection credit. Second-owner HTTP isolation is
pending: ordinary storage has a singleton owner, and this runner does not invent
another owner authority. Spoofed input and nonexistent scope checks are distinct.
Configured broker factory, live provider/Stop, browser and release gates remain
pending. Separate ec38 Store tests cover transaction-entry revocation/expiry and
guard-removal mutation. No prior crash matrix was repeated; no CI pass is inferred.

Matching successor `286607bb90ef2e55d0fbcbb08082ef32f7deef4f` independently
passed the matrix with candidate projection present and exactly linked to the
completion/run/revision. The extended Python oracle then passed again (one test,
zero failures/ignored, 0.32 seconds): authenticated SSE replay after duplicate
acceptance returns contiguous sequences 1..4 with schema versions 1,5,5,9. The
completion and acceptance event IDs match the committed HTTP decision, and the
schema9 payload links the exact run/completion. Reading replay changes no ledger
rows. This is actual HTTP journal ordering, not provider execution or mounted
browser evidence. The older pin's pending candidate result remains historical.
