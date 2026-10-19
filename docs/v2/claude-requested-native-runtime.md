# Claude process initialization and native observation

This adapter requires the complete Store source at
`5fc15592632bd96ca271ba6bcc8486442abd27ff` (migrations 1 through 30).
Its matching broker wire is `356c578af93ec944d93222579db90d67fc6400ec`.
These are source dependencies, not activation evidence.

`PreparingClaude::poll` sends only the closed control initialize request using
metadata-fenced actual provider writes. A matching sanitized ACK completes protocol
initialization. `confirm` consumes the original metadata grant through
`initialize_claude_session`, reserving the launcher's requested UUID as UNOBSERVED.
It never calls native-session confirmation with the ACK.

`ReadyClaude::attach` consumes the existing non-Clone dispatch capability and
transfers the same child/writer under the execution fence. CommitExecution uses
outer request 3, after metadata request 2. The first matching native system/init
is validated by the channel and ClaudeRpc, then retained while the pump calls
`observe_claude_session` with a stable run/binding-generation key. Only after that
transaction succeeds does the pump append Started and process subsequent output.
Busy/Unavailable preserves this pending identity and key without reading another
frame. Permanent refusal quarantines the child. Completion remains a proposal;
owner acceptance is separate.

The callable API names and ownership remain PreparingClaude::open/open_retained,
poll, confirm; ReadyClaude::attach; ClaudePump::flush/step. Poll readiness means
protocol initialization, not provider-observed native identity or subscription
attestation. The original checkpoint below covered only the first turn. Accepted
continuation is composed by the ordinary server; the later
[Claude cancellation adapter](claude-stop-runtime.md) adds a distinct consumed
control path with original-tree cleanup evidence.
Trusted selected-account configuration remains outside the public repository.

## Bounded validation

A disposable full Core export was overlaid with the Runtime source delta and
byte-identical lane workspace manifests and lockfile. No dependency resolution,
version change, migration substitution, or tracked shared-Store edit was used.
The broker files came from the exact matching package inventory above; shared
Python transport files must not replace newer integration files wholesale.

The locked/offline `orkestr-runtime --lib claude` selection passed 37 tests,
including four ordinary Store/owned synthetic-process cases: durable progress
and proposal, failed terminal result, and credential revocation after emitted
system/init but before identity persistence. The latter appends neither Started
nor output. The fourth case holds an independent SQLite write transaction until
the real observation call returns Busy/Unavailable, verifies pending identity is
retained, then commits the exact observation outside the pump to model a lost
success reply. Pump retry uses the same key and completes normally. This models
a lost reply; it does not inject a network or disk failure. Existing parser/codec tests cover identity, correlation, preparation,
actual-write ordering and bounded malformed input. This does not qualify HTTP,
authenticated native execution, resume, or full release readiness.
