# Timer web presentation checkpoint

The unmounted timer detail component keeps fresh owner instructions editable
with native text controls. State, held reasons and scheduling-controller status
use human-readable labels. Enabled-but-unarmed after restart is distinct from
armed scheduling, and neither implies execution or completion. Disabling a
schedule does not claim to stop work already admitted.

The component deliberately has no transport or enabled mutation controls yet.
The timer HTTP owner has supplied route semantics; the immutable published DTO
and leaf checkpoint is still needed for the adapter. Schedule details and due
time are not fabricated, and no client due/claim authority is constructed.
Factory registration and matching browser acceptance remain separate gates.
