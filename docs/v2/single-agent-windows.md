# Single-agent conversation windows

Configured conversations run one native Codex or Claude agent by default. The
agent receives the original conversation input and owns its tools, useful
progress and canonical final reply. No Fast companion or read-only parallel
conversation pool starts alongside it. Explicit scoped Worker tasks remain
available to configured Codex agents.

The existing role launcher inventory and historical Fast receipts stay readable.
Keeping `roles.fast` or `claude.fast` in an older package does not enable a new
companion. The default also advertises Fast as unconfigured while preserving
Worker discovery. No schema or conversation-history conversion is needed.

`legacy_companions: true` in the root-controlled `beta.json` is an
operator-only composition switch. It restores the read-only Fast companion
(and the parallel reply pool) beside each conversation agent, so a short
owner question gets a quick answer while a long agent turn is still running.
It is never inferred from a client request, enabled by new provisioning,
selected in the UI or used as an automatic fallback: turning it on is an
owner decision. Historical dual-role process fixtures set it explicitly; new
single-agent acceptance omits the field for both providers.

The selected service plan carries the switch: `legacy_companions` (boolean,
optional) is copied into the packaged `beta.json` only when it is `true`, so
absent and `false` produce the same single-agent package. A plan that sets it
without a Fast role (`roles`, or `claude.fast` for Claude) is refused, because
it would start nothing. The adapter has its own matching operator
configuration (`legacy_companions` at the top level of its service JSON).
Switch both in the same release: the adapter alone cannot start Fast, and
the server alone runs Fast replies that a single-agent adapter never exports.

Changing the default does not authorize accepting an old proposal, forgetting
an unresolved child or replaying an input. Existing windows must pass their
normal drain or supported reconciliation before switching an installation.
The same owner, source, lease, revocation, original-child and canonical
acceptance checks still govern the single agent and its Workers.

`identity_split_single_agent_http.py` exercises three owner turns, canonical
acceptance, window retirement and exact native-session resume using disposable
synthetic providers and real Core/Root custody. Its Codex case also runs two
explicit Worker tasks. It requires zero Fast Core runs and Root launches.
These fixtures do not prove real provider-account or production acceptance.

The bounded Codex/Worker fixture requires the existing Linux x86-64 syscall
policy. On ARM Linux, `--provider codex --managed-host` exercises the same
single-agent window and resume lifecycle without claiming bounded Worker
acceptance. Neither test option changes the production sandbox policy.
