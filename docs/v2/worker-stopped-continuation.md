# Worker proof retention across a stopped parent continuation

Fresh input after a genuine parent Stop can request metadata-only continuation
without retiring the configured supervisor. The old input held by Stop remains
held. Core's eligible-input read is the wakeup; the existing one-use metadata
reservation and current metadata fence remain the authority for process setup.

`WorkerReaps::stopped_metadata` consumes the original `ReapedBroker` for the
latest registered parent. It requires the exact original scope, the released
binding generation, and original proofs for every historical Worker launch.
Missing setup evidence, unknown cleanup, an earlier attempted continuation,
an in-flight handoff, a poisoned ledger or final freeze refuses the operation.

The handoff retains the original parent proof in the factory ledger before
awaiting Core. Its private guard poisons the ledger if reservation fails, the
future is cancelled, or the returned typed metadata does not match. Success
clears only the in-flight marker. The one-use parent record and all original
parent/Worker proofs survive subsequent accepted turns and stopped resumes.
No caller-supplied boolean, PID, status label or alternate proof constructor
can open the next turn.

The aggregate capacity is 2,048 original native proofs, including the current
parent and space for the replacement parent before a stopped continuation.
Capacity refusal happens before ledger mutation, metadata reservation or spawn.
Historical proof entries are never evicted to create room. Parent turn identity
records have their own 2,048 bound because accepted turns share one native child.

The factory's `worker_stopped_grant` helper checks the owned resource barrier
and current supervisor authentication, then delegates the proof handoff and
Core reservation. Core must enforce the same descendant negatives as final
retirement at stopped reservation and later metadata-fence/confirmation use:
pending task authority, unresolved delegations/setup, tools, result suffixes and
control acknowledgements remain disqualifying. A metadata reservation never
authorizes inference; a fresh ordinary consumed dispatch is still required.

Final context retirement remains separate: `finish` freezes once and retains
the current parent, every reaped prior parent and all Worker originals across
the current-auth Core transaction. It refuses an in-flight or failed continuation.
Original witnesses cannot be reconstructed after a server crash.

The focused module tests exercise refusal and cancellation bookkeeping without
constructing Runtime proof. Actual synthetic HTTP/process qualification and
shared factory registration are separate; no live provider or production
qualification follows from these unit tests.
