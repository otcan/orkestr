# Secret scanner interruption and residue

The scanner wrapper handles SIGTERM and SIGINT while collecting a scan. Its
asynchronous version probe and scan run in separate owned POSIX process groups.
On interruption it immediately sends SIGKILL to the active scanner group,
including Git children that have not left that group, waits for process closure,
and removes this run's temporary report directory. The wrapper records
`complete: false`, `ok: false`, and `category: scan_interrupted`, then exits
nonzero. Repeated handled signals do not bypass cleanup. It never signals the
wrapper's process group or locates processes by executable name.

The CLI arguments and injected synchronous fake-runner contract are unchanged;
injected runners may also return promises. Injection is for tests: blocking
custom runners cannot provide the default asynchronous runner's responsive
signal handling. Git revision checks remain bounded synchronous operations;
a signal during those short checks is handled when control returns to Node.
POSIX group termination is the supported CI/host path. On Windows only the direct
child is terminated; descendant cleanup is not qualified there. A scanner that
intentionally creates another session escapes group ownership; this mechanism
is process lifecycle management, not a sandbox for untrusted executables.

## Limits and recovery

SIGKILL, a runtime crash, power loss, filesystem failure, or a supervisor that
kills the wrapper before cleanup completes can leave residue. No signal handler
can guarantee cleanup in those cases. Evidence created before scanning starts
is nonpassing until collection and transient deletion complete. Missing,
truncated, or incomplete evidence must never be treated as a successful scan.
A failed cleanup remains a failed run; it does not imply that residue was removed.

Temporary directories are private (mode 0700) and named
`orkestr-redacted-scan-<evidence-runId>-<random-suffix>` beneath the wrapper's
selected temporary root. Redacted reports can still contain sensitive metadata.
Do not publish, print, or attach them to tickets or CI artifacts.

After an uncatchable interruption, use the private evidence run ID and the
supervisor's recorded temporary root to attribute a specific directory to the
run. Confirm the wrapper and its owned scanner processes have stopped, check the
exact directory's owner, real parent, and absence of symlink substitution, then
remove only that attributed directory through the operator's approved private
cleanup procedure. A prefix match or a PID alone is not sufficient attribution;
PIDs can be reused. If attribution is uncertain, retain privately and investigate.
Never sweep guessed global temporary paths or delete other runs' directories.
Prefer a private per-job temporary root whose lifecycle is owned by the job
supervisor, allowing cleanup after wrapper death without inspecting reports.
