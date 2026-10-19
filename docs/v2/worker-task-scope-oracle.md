# Two-parent Worker task scope

`v2/tests/worker_task_group_http.py SERVER [--report PRIVATE_REPORT]` exercises
two configured conversations under one browser owner, each with an independent
Deep parent and an owner-created Worker. It reuses the ordinary group fixture,
task protocol peer, actual HTTP routes, broker and external host-identity probe.
No real account or existing state is used. The server process test registers it
without a feature flag or an alternate production control API.

The oracle rejects cross-conversation task creation and receipt replay, foreign
parent task lists, foreign execution locators, task IDs used as run IDs, foreign
Stop, hold and payload deletion. It compares both conversations' task, dispatch,
observation, cancellation and acceptance ledgers and native calls before/after.
Read-only snapshots are pinned transactions over the disposable test database;
they omit credentials and lease timing, which may change independently.

Stopping Worker A must produce real interrupted terminal evidence and reap its
exact host identity while parent A, parent B and Worker B remain live. Worker B
must subsequently propose its own result and require explicit owner acceptance.
Wrong-conversation and wrong-run acceptance remain refused. Both parent trees
are then stopped independently and all observed identities and temporary state
must be gone. Reports retain actual responses, snapshots and cleanup evidence
on failure as well as success.

This extends the existing same-parent Worker and two-parent Deep coverage. It
does not qualify real providers, browser rendering, performance or a full release.
When the test commit differs from a sealed product artifact, record both source
revisions and use the artifact's matching broker/fixture export with only these
new oracle files overlaid. Never relabel an older binary as the test revision.
