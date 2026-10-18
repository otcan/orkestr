# Codex output evidence checkpoint

The bounded Codex 0.163 turn parser correlates one submitted request, native
thread and returned turn. It holds notifications until the matching successful
response, distinguishes acknowledgement from Started, and maps completion only
to CompletedProposal. Unexpected EOF is loss, never completion. Malformed or
foreign evidence poisons the parser. Frames, progress and queued events are bounded.

The private output pump transfers an already owned child and performs at most
one bounded stdout read per step. It uses the existing pending-observation cursor:
Busy or Unavailable preserves the original admission, sequence and body, and no
new child output is read until persistence acknowledges that observation.

Ordinary Store source is imported path-only from Core
`108f87c306b785d2f06c1aa0b2ad30989c87e440`, including its reviewed metadata
prerequisite and schema5 observation DTO. Shared workspace and lock are unchanged.
Actual ordinary-Store tests drive an owned synthetic protocol child through
consumed dispatch, Started and completion proposal. A second case shows raw
Progress remaining pending without consuming a later completion, because the
removable payload persistence port is unavailable.

The execution composition remains test-only. Metadata attachment, the canonical
subscription broker route, real provider pumping and production registration
are separate gates. These synthetic tests establish no live provider acceptance.
