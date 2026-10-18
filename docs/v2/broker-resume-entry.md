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
This constructor is a trusted launcher hook, never a client-selected native identity or issuer. Runtime supplies only the exact Core-issued binding.

All actual native metadata/turn/control writes remain on Runtime's sole writer,
inside the corresponding current durable Core fence, including each partial-write
suffix. No broker-side native write fallback is introduced. Duplicate or late
correlated replies refuse. The subprocess bootstrap tests and protocol tests are
synthetic; actual authenticated resume and ordinary HTTP recovery are unexecuted.

Codex now also has the fixed `resume-owned-session --protocol
orkestr-v2-provider-broker-v1` executable entry. Its private descriptor-4 record is
`codex-resume-v1` plus NUL, followed by a nonempty UTF-8 native identifier of at most
512 bytes, then EOF. Control characters, oversized records, wrong-parent sockets
and startup timeout refuse. It uses `codex_bootstrap.py`, which must be included in
an immutable Codex package. Descriptor 3 is unchanged. The launcher must select this
entry and send the identity solely from the opaque metadata grant binding.

The containment broker-only shape validator admits precisely the five resume
parameters above; direct raw metadata remains unchanged. This shape guard cannot
prove an issued native identity. Runtime and the trusted broker binding enforce
that comparison. Runtime's current actual-FD parent hook now duplicates both socket sources above
fd4 before assigning the two inherited descriptors. The bootstrap record is a
bounded nonblocking local socket write with EOF, never a broker reply wait. Only
the opaque Codex grant's binding selects resume and supplies the identity; neither
argv nor JSON carries a caller-selected resume locator. Existing cancellation and
actual-provider suffix fences remain unchanged. Matching-source dual-channel,
closed-frame and existing ordinary Store session tests execute separately from
issuer/reap qualification. Installed-native resume schema verification and an
actual resumed ordinary process remain pending.

The immutable Codex inventory is `v2/provider-broker/codex-package.json`. It includes
`codex_bootstrap.py`; staging an older inventory cannot qualify resume.
