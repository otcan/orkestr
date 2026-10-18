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
