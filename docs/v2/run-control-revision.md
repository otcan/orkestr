# Run control revision

ExecutionStatus.revision remains the complete per-conversation projection version.
Progress, queued input and sibling execution changes continue to advance it.
ExecutionStatus.control_revision is an optional positive exact-run control CAS.
It advances for that run's state, dispatch state, fence or incarnation changes;
Progress and other runs do not change it. No run means no control revision.

Stop may supply expected_control_revision alongside the original expected_revision.
The write transaction authenticates the original browser credential, exact owner,
conversation, run, bound supervisor and current execution authority. For a fresh
request with a control revision it compares that exact run's control revision;
the sampled projection must be nonnegative and no greater than the current
projection. It need not still be latest: streaming progress may advance it. Future
projection claims conflict before any cancellation writes. A request
without it retains the legacy strict conversation-revision comparison.

Both requested revisions and the request key are immutable idempotency input.
Replay authenticates current credentials before returning the original receipt;
changing either requested revision conflicts. Historical receipt replay never
creates another interrupt or changes a successor. Expected projection revision
still appears in the original receipt; it is not falsely relabelled a control CAS.
Owner acceptance retains its separate exact projection-revision policy.

Migration 0024 initializes existing runs to control revision one, installs
per-run insert/control-transition triggers and stores the optional requested
control revision beside the original cancellation receipt. Projection triggers
are unchanged. This does not authorize native Stop or advertise availability:
server composition must still deliver the exact issued CancelReceipt to its
owned transport and confirm Stopped with that separate cancellation-purpose token.
