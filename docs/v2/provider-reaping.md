# Owned native retirement

The trusted broker enables Linux CHILD_SUBREAPER before native spawn. Native is
in its own process group, not the broker group. On private parent stdin EOF the
broker closes its pipes, kills the owned native group while the direct child PID
is still unreaped, and collects direct/adopted children until waitpid reports
ECHILD. Only this successful path exits 73. Normal zero, refusal, signal exit,
timeout, forced broker death, and living escaped descendants grant no proof.
No PID or JSON receipt from a client is consulted. This is a single-use cleanup
operation; never repeat group signaling after reaping the direct child.

Runtime must close actual native writer and broker input, retain the actual broker
Child through wait, and mint its private reaped token only on exit 73. Its forced
kill fallback cannot mint a replacement token. Native now has a separate process
group: killing only the outer broker group is not tree cleanup. Unexpected broker
SIGKILL can leave descendants and must quarantine, not authorize replacement.
The two-second cleanup deadline is bounded and intentionally fails closed.

Synthetic tests cover direct/group descendants and an escaped living descendant
which prevents proof. Existing subprocess tests check EOF exit 73 and refusal
exit 2. No real provider or immutable production package was launched. Immutable
Codex staging must add reaping.py; Claude inventory includes its exact hash.

## Abrupt broker death

The private native group is now wrapped by fixed root-owned Bubblewrap with
unconditional user/PID namespaces and `--die-with-parent`. Namespace-init death
kills descendants even after setsid/double-fork. This is required, never a
best-effort fallback. There is no Python preexec hook. The trusted connector's
existing filesystem/network view is preserved by this lifetime-only wrapper;
this does not satisfy authenticated filesystem/egress isolation. Proc is scoped
to the PID namespace. Bubblewrap sets PWD to the working directory; other child
environment still comes solely from the closed selected-provider builder.

The actual subprocess regression SIGKILLs a disposable broker after an escaped
native descendant starts. It requires all inherited output writers to close and
all adopted children to disappear (`ECHILD`), not merely the broker exit. Forced
broker death still never yields exit-73 retirement authority. The old uncontained
escaped-descendant test remains as a negative oracle showing group cleanup alone
cannot issue proof. Root must repin/review the new lifetime launcher dependency
before any provider activation; no live service or provider was touched here.
