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
