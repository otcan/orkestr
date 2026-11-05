# Source handoff receipt evidence

Root records a scoped decision; the originating executor keeps business work.
An ambiguous send is never automatically replayed, including when a read cannot
find the input. The SRE reconciliation helper has no submit callback.

The owner-authenticated, read-only ports are:

* `POST /api/v2/conversations/{id}/source-runs/lookup`: exact original run and
  input message identify Core's source native session, provider, current provider
  generation and binding generation. A retired, changed or reset binding is
  ineligible. This context is not evidence of the owner's intent.
* `POST /api/v2/conversations/{id}/source-receipts/lookup`: exact deterministic
  client key, text SHA, original source run/native/provider/generation and
  `v1_agent` attribution identify an admitted continuation. The response binds
  the actual owner/conversation and canonical message/event IDs and sequence.

Both ports reauthenticate the credential in their Core read transaction. Browser
POSTs retain the ordinary origin/Host/CSRF guard. No query admits input, opens a
window, changes acceptance or performs work. `source_receipts_v1` in health
advertises the capability.

Migration 0090 records fresh continuation fences atomically with the original
admission and authentication provenance. Provider/native/binding mismatches roll
back the complete admission. Replays never acquire or replace this evidence.
Historical inputs are not backfilled; missing original fences or provenance
produce `legacy_unproven`. Missing evidence never authorizes another send.

Core projects the actual continuation input's consumed reasoning-inbox lineage
to a Deep run, including explicitly grouped inputs. Its actual completion,
acceptance and canonical preceding progress payload remain separate fields.
The original source run's completion cannot satisfy the continuation. A requeued
or unconsumed input may have no current run projection; that absence does not
prove no prior effects and is not replay permission.

`scripts/sre/source_handoff_receipts.py` can reconcile a claimed/unknown handoff
from this trusted Core port and ingest bounded, immutable attributed reports.
A report's claimed run ID never selects the Core result. Provider/native/binding
changes and disagreement with Core's canonical payload are visible as unverified
attribution. Even an accepted model proposal is not an external business receipt:
`business_state` stays `unverified`, `verified_business_receipt` stays absent and
`work_completed` stays false. Domain-specific trusted effect attestors are outside
this port; neither model narrative nor delivery/review status can close business
requests.

Protect the handoff directory from executors. Cutover of a private Root adapter
requires separately reviewed Core custody, protected intake, an exact candidate
manifest/build identity and qualification of the typed ports. Public helpers do
not enable a live watcher or migrate historical request status.
