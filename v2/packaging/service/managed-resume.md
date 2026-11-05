# Managed native continuation

Split-identity launch supports fresh sessions and accepted Deep/Fast native
continuation. Worker slots still start fresh. Selecting this support does not
enable the production split or qualify other workspace/privileged-helper modes.

The existing Core metadata grant and original retired/reaped continuation ticket
select the provider, session, binding generation and native identity. Runtime
adds a fifth one-use descriptor for the private resume bootstrap. Its setup
attestation also includes the original `production_resume_metadata.id`, exposed
only as a non-authorizing locator. Distinct accepted continuations can keep the
same binding generation while requiring distinct Root launch claims. A lost
claim or reply never permits a replacement launch.

Root verifies the exact source server, all descriptor types/peers, original
stopped Child proxy and provider-specific fixed operation. It transfers the
original bootstrap to the executor broker after dropping privileges and setting
`no_new_privs`. The broker compares its original authority-process peer and
bounded record against the Root-attested native identity before initialization.
No native identity comes from stdio, arguments, environment or a model request.
Metadata readiness and consumed dispatch remain separate Core fences.

An unassigned kernel-adopted authority proxy receives only physical cleanup
custody, just like an executor orphan. Root retains original pidfds, quarantines
the manager and never reconstructs a role, completion or replay permission.

The opt-in `v2/tests/identity_split_resume_http.py` runs disposable actual
Core/Root HTTP rehearsals with fixed synthetic Codex or Claude natives. Three
ordinary inputs cross a supported idle drain, preserve exact native identity,
exercise further continuation in the successor window and clean up the original
process families. The receipt distinguishes the server identity and binary hash.
It does not run a real provider or modify live accounts or service configuration.
