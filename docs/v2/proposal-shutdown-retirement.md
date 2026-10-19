# Acceptance racing shutdown

The ordinary Codex loop can sample `AwaitingAcceptance`, then owner acceptance
can commit before shutdown is observed. Discarding the pump using that old
sample loses the original child needed for graceful retirement, despite the
accepted run and successful physical cleanup.

After observing shutdown in this branch, read the exact run again. A matching
`Completed` run returns to the existing completed-session path, which consumes
the original pump, obtains its typed tree-reap evidence and invokes Core
retirement. An unaccepted proposal still receives cleanup without retirement.
Read failures or changed run identity refuse retirement.

The existing `configured_without_launched_workers_needs_no_invented_proof`
HTTP case exercises accepted shutdown and restart. The companion
`unaccepted_parent_shutdown_cannot_retire` case verifies that shutdown without
acceptance produces neither accepted nor stopped retirement, nor a Stopped
observation, and refuses configured restart.

For deterministic diagnostic reproduction, suspend the loop for 250 ms
immediately inside the `AwaitingAcceptance` branch, before `steering.retire()`.
Run the accepted no-worker case unchanged against both sources with this same
suspension. It commits acceptance and shutdown while the old phase is retained:
the old source loses retirement; the correction retains the original pump and
retires successfully. This suspension is a diagnostic scheduling overlay only;
it is absent from the product and does not enlarge any cleanup deadline.

This identifies a reproducible cause matching the missing-retirement failure.
The hosted failure had no retained state artifact, so its precise interleaving
cannot be reconstructed. Idle broker-exit detection remains enabled, and no
process exit or empty child counter grants retirement authority.
