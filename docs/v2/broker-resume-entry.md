# Private fresh-process resume entry

Claude's fixed `resume-owned-session --protocol orkestr-v2-provider-broker-v1`
entry requires two new parent-created Unix stream socketpairs. Descriptor 3 keeps
its existing sole-provider-writer SCM_RIGHTS handoff. Descriptor 4 receives exactly
`claude-resume-v1` followed by NUL and the 36-byte canonical native UUID, then EOF,
within one second. The peer must be the actual parent with the same effective UID.
The bootstrap closes descriptor 4. No stdio message, environment variable or argv
selects the UUID. A fresh process, lineage token and descriptor-3 handoff are
required; an existing channel cannot be reset.

This private pipe trusts Runtime, not JSON as evidence of Core authority. Before
launch Runtime must consume its opaque retired/reaped ticket, prove terminal
completion and durable owner acceptance, close old readers/writers, wait for the
old child, and obtain Core's accepted-session metadata grant. The bootstrap does
not independently verify those facts. The selected-account callback remains
server-private. Resumed assistant/result frames require the exact current input
UUID; missing or foreign correlation refuses rather than relabeling late output.

Codex's internal `Channel(workspace, expected_native=...)` supports only the closed
`thread/resume` metadata request with `threadId` equal to that trusted local
binding, canonical `cwd`, `approvalPolicy: never`, `sandbox: read-only`, and
`modelProvider: openai`. There is no ephemeral request field on resume. The reply
must prove the same thread ID and workspace, persistent `ephemeral: false`, OpenAI
provider in both thread and result, and read-only/network-off policy. A bound
resume channel refuses thread/start; an ordinary channel refuses thread/resume.
This constructor is an integration hook, not a client-selected launch entry or an
issuer. Runtime must supply the exact Core-issued binding; no new Codex executable
resume selector is published here.

All actual native metadata/turn/control writes remain on Runtime's sole writer,
inside the corresponding current durable Core fence, including each partial-write
suffix. No broker-side native write fallback is introduced. Duplicate or late
correlated replies refuse. The subprocess bootstrap tests and protocol tests are
synthetic; actual authenticated resume and ordinary HTTP recovery are unexecuted.
