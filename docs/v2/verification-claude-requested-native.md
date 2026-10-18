# Requested Claude native identity: independent verification

Reviewed Core `5fc15592632bd96ca271ba6bcc8486442abd27ff`, including migration 0030, metadata reservation, observation, continuation and canonical replay ordering. No bounded source blocker found. Initialization reserves an unobserved identity; unseen execution evidence requires observation under current consumed authority. Cleanup remains possible without inventing Started. Accepted and confirmed-Stopped continuation require a new observation at the new binding generation.

Independent execution of the five supplied ordinary Store tests passed (5/5). These remain Core-authored tests. Independently authored `v2/acceptance/claude_identity_boundaries.rs` passed (2/2): revocation between metadata authorization and initialization leaves the ledger unchanged; Stop before observation and revocation after observation refuse late identity writes, including identical observation retry. Assertions compare the existing full-row snapshot oracle, including requested-native rows, through a separately reopened pool.

To reproduce, export the exact Core revision into an owned disposable directory, append the acceptance source inside its existing `production_runtime/claude_identity_tests.rs` module, and run the required Cargo wrapper from `v2` with an isolated target/home:

```text
test --offline --locked -p orkestr-v2-store-sqlite --features fixture-test-controls --lib claude_identity_tests -- --test-threads=1
```

No shared implementation edits, private authority reconstruction, provider launch, credentials, native protocol execution, process crash, browser or activation credit. Runtime must retain genuine matching system/init evidence across transient persistence failure and persist it before emitting Started. These authored tests require another lane's independent review.
