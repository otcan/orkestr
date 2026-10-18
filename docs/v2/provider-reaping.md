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
