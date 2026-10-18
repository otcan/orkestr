# Owned broker composition checkpoint

Runtime now has a private `execution::session` setup/attachment state machine.
It is registered under the existing test-only execution boundary; it is not a
production HTTP dispatch service or permission to activate a canonical account.

The trusted launcher receives a Core-issued Starting metadata grant. The same
owned child performs correlated OpenOwnedSession, initialize, initialized,
account/read and persistent thread/start. Runtime requires OpenAI authentication,
ChatGPT account type, explicit matching `modelProvider: openai`, persistent native
identity, exact canonical workspace and read-only policy before Core readiness.
No setup frame may submit inference. A child-local Arc identity seals each setup
request and the eventual CommitExecution; a second child with identical scope
cannot borrow that lineage.

After ordinary Store admission, reservation and atomic consumption, ReadyCodex
consumes the issuer's non-Clone dispatch together with the original child.
Core's Ready transition and actual SQLite execution fence guard transfer and
initial enqueue. The private wrapper derives the turn input/message/native IDs
only from the consumed capability. Correlation reservation is once-only and does
not confer authority. Every subsequent flush/read uses the issued scope/fence.

The bounded output pump unwraps correlated broker replies and notifications,
then validates Codex turn evidence. The existing pending cursor journals Started,
Progress and completion proposals through ordinary Store before reading further
output. Progress uses Core's removable scoped payload storage; completion stays
AwaitingAcceptance. Owner acceptance is separate. Failed setup/attachment or
uncertain writes do not recreate a grant or retry execution automatically.

## Evidence and remaining work

Two actual ordinary-Store tests cover setup through consumption, same-child
attachment and durable Started/Progress/completion. One starts the standalone
Python broker with a synthetic provider executable and disposable private
configuration; the other isolates the Runtime wire state machine. Both require
terminal consumption refusal and inspect the durable Progress payload.
This is synthetic executable composition, not real-provider or HTTP-to-runtime
acceptance. The standalone server repairs originate at Isolation commit
405ad039; sealed containment hooks originate at c94bd793.

Production HTTP composition, independently reviewed activation, actual
subscription-provider execution, fenced broker interruption and persistent
follow-up remain separate pending work. The client deliberately allows one
execution per owned channel in this checkpoint. No credentials, existing native
sessions or production socket are imported by these tests.

## Trusted server library boundary

`orkestr_runtime::execution` exports opaque `PreparingCodex`, `ReadyCodex`,
`CodexPump` and `SetupFailure`. `PreparingCodex::open` takes the ordinary Store,
Core's non-Clone BoundSessionMetadata, a trusted fixed launcher path, canonical
workspace and ChildDirectories. `poll` performs bounded setup; only successful
`confirm(self).await` returns ReadyCodex. `attach(self, Store,
Box<ConsumedProviderDispatch>)` consumes both readiness lineage and committed
single-use dispatch, returning Authority and CodexPump for the same child.
`flush` and async `step(&Store)` perform bounded fenced writes and durable
observation acknowledgement. No constructor accepts caller inference JSON.

These exports allow a separately reviewed trusted server factory; they do not
configure one, activate HTTP dispatch, establish credential access, or implement
broker interruption. Stop currently persists intent; actual sealed broker
control submission remains a separate prerequisite. Defaults stay unconfigured.

POST `/api/v2/conversations/{id}/accept` uses canonical schema-9 request/receipt,
Origin/CSRF and cookie-only authentication. The exact namespaced credential is
revalidated inside Core's acceptance transaction, including receipt replay.
200 returns the validated receipt; malformed input is 400, authentication 401,
foreign/missing scope 404, conflicting revision/state 409, unavailable store 503.
The request preserves its completion EventId/run/revision/key across uncertain
retries. Provider proposals never invoke this owner decision automatically.

### Actual provider-write activation hold

The current broker pipe is a second hop: fencing Runtime's write into that pipe
alone does not serialize a later broker write into provider stdin with durable
revocation. The synthetic composition tests do not prove that missing boundary.
Real provider activation remains held until the broker relinquishes its provider
writer and the trusted Runtime owns each bounded nonblocking provider write
under the appropriate Core fence, or another reviewed equivalent is implemented.
Waiting for a broker/provider acknowledgement inside a SQLite fence callback is
not an acceptable replacement for a bounded write. Sealed cancellation/control
must use the same actual-write boundary; a durable Stop receipt alone remains
intent, not interruption evidence.
