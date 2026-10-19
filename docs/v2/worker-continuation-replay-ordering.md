# Historical Stop replay and successor progress

The synthetic continuation fixture emits Started and then Progress. The ordinary
server commits those as separate observations. Running and task availability do
not imply that the initial Progress observation has already committed.

The replay oracle gates that successor Progress, captures the Running state,
releases the gate, and requires exactly one new Progress observation for the
successor, with all other sampled ledger fields and native trace unchanged.
It then captures its replay baseline. Exact historical Stop replay, a new key
against the old run, and a stale Worker task request must each leave the complete
sampled ledger and native trace unchanged. No observation fields are excluded
from those comparisons.

A controlled baseline schedule released Progress after the replay baseline and
reproduced the prior equality failure: one successor Progress observation was
the sole difference. This establishes a fixture race; it does not recover the
interleaving of a hosted run whose state artifact was unavailable. The repair
changes only the synthetic peer and oracle, not product control behavior.
