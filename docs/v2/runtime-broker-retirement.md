# Owned broker retirement evidence

`CodexPump::retire_broker(self)` and `StoppingCodex::retire_broker(self)` consume
all local pump/cursor state and return `RetiringBroker`. The caller must first
persist the genuine terminal observation and separately satisfy Core eligibility.
Retirement itself grants no Store or provider authority.

The transport closes the provider writer and broker input, disables further
writes, and detaches the exact Process from the old Authority's child membership.
Dropping that Authority cannot kill the transferred cleanup owner. Polling uses
WNOWAIT followed by wait on the original owned Child; no caller PID or JSON exit
assertion is accepted. Only trusted broker exit 73 returns the non-Clone,
non-serializable `ReapedBroker`, bound to its original execution scope. Ordinary
exit, signal death, or wait failure never returns proof. Dropping retirement
early uses the existing forced cleanup/reaper and grants no proof.

Exit 73 is meaningful only with the reviewed broker retirement implementation:
subreaper cleanup through ECHILD, plus mandatory fixed Bubblewrap PID lifetime
containment for abrupt broker death (Isolation e460d1c06). Existing broker
packages without that contract must not enable this API in server composition.
Root must review/pin Bubblewrap and exact immutable inventories before adoption.
This checkpoint does not import or activate that package, or qualify authenticated
filesystem/egress isolation.

The Runtime tests use owned synthetic processes. Clean EOF kills and reaps an
actual private namespace tree including a forked setsid descendant before proof;
ordinary/raw executor exits and forced death refuse proof. The exact external
broker archive's separate 62 Python tests cover the implemented EOF and abrupt
broker-death protocol. Neither test set establishes Core continuation eligibility
or an actual provider restart.

For graceful Stop retirement, opt in with
`pump.into_stopping(store, &receipt)?.retaining_terminal()` before driving Stop.
Only a canonical durable Cancelled receipt retains the owned child; ACK-only,
errors, and competing terminal evidence keep existing cleanup behavior. After
Stopped, consume `retire_broker` before revoking/dropping the old Authority.
Default callers still quarantine on durable Stopped. Retention is not reap
proof or replacement authority, and dropping the retained handle still cleans up.

The ordinary Codex lifecycle also checks its retained broker while waiting for
the first input, owner acceptance, or a subsequent input. A nonblocking WNOWAIT
observation of exit quarantines that exact local handle and sends its original
Child to the existing retained-resource reaper, even while HTTP remains live.
The Ready phase fence cannot clean up a child already transferred to execution.
This loss path produces no observation, acceptance, Stopped status, retirement
proof, resume grant, or replacement process; unresolved durable state requires
reconciliation. It never interprets a dead helper as a provider terminal event.

The synthetic ordinary HTTP regression kills the exact owned broker in all three
idle states and requires every recorded PID/start identity, including zombies,
to disappear before server shutdown. Bindings and durable execution evidence
must remain unchanged, and a later admitted input cannot start another run.
