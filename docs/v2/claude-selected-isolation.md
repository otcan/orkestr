# Opt-in selected Claude isolation

`isolation.claude_selected.SelectedClaudeProfile(private_configuration)` uses the
same root-immutable native/supervisor/egress validation and fixed namespace,
resource, syscall and exact CONNECT proxy policy as the Codex authenticated
profile. Private format `orkestr-v2-claude-isolated-v1` has exactly format, native,
state_root, egress_socket, supervisor, hosts, workspace. No auth path, token,
account selector, environment override or billing configuration is accepted.
State is a dedicated private role directory validated by `claude_state.py`.
Only workspace-bound project transcripts persist into a subsequent child.

Trusted launcher calls `profile.selected_account(selected_callback)` where the
existing selected-account provider returns exactly CLAUDE_CODE_OAUTH_TOKEN. This
private capability is single-use, profile-bound and non-copyable/nonserializable.
`profile.exec_native(capability, requested_native_uuid)` replaces the launcher;
no arbitrary command can be supplied. The UUID must come from the existing
trusted session setup composition, never a browser value; it is not Core proof.
There is no generic `start()` fallback and no new login/account creation.

The token crosses only a sealed anonymous memfd, never CLI/config/filesystem
state. The trusted namespace supervisor reads/closes it before spawning native,
then injects only the explicitly selected OAuth variable in the clean native
environment. Native needs that subscription token by design. This is not a claim
that trusted native cannot inspect its own selected token. The supervisor does
not inherit parent secrets, copy canonical account state or expose the selected
root egress Unix endpoint to native. TLS remains end-to-end through the existing
bounded exact-host proxy. No host-network or API-key fallback is supported.

Fixed native flags mirror ClaudeOwnedSession's restricted, no-tools/no-MCP,
stream-JSON profile. Actual native flags/metadata handshake must still
be qualified inside this profile. Control initialize ACK is process readiness
only; the separate Core requested-native/verified-native contract remains open.
The selected-account callback and executable wrapper remain root-private and
must be independently reviewed/staged; no actual selected-account launch was run
by this lane. Inventory includes claude_selected.py and claude_state.py (nine files total).

Synthetic tests use only a fake token. An actual namespace process verifies its
single selected environment, absence of unrelated inherited secrets/API keys,
empty private state, closed credential FD and denied direct Unix/external socket
access. Existing exact-host synthetic proxy tests cover permitted egress; no
real DNS, authentication or inference request is made. Parent-controlled path
and concurrent-replacement assumptions remain those of the authenticated profile.

## Immutable compatibility probe handoff

Stage exactly the nine files and SHA-256 values in
`v2/provider-broker/authenticated-package.json`, retaining the `isolation/`
package layout. The entry is `isolation.claude_selected.SelectedClaudeProfile`;
there is no standalone account-selection CLI. The trusted private launcher
loads the immutable configuration, obtains the existing selected-account
callback capability, and calls `exec_native` with its issued requested UUID.
Root-controlled native, workspace, endpoint and configuration ownership checks
remain mandatory. The broker protocol package has a separate inventory;
`claude_telemetry.py` must accompany `claude_protocol.py` there.

For the next isolated compatibility probe, keep stdin open, send the exact
closed initialize control request, verify its correlated sanitized success,
then submit the separately authorized user frame with a fresh UUID. Empty
optional pending arrays are supported; nonempty arrays refuse readiness.
Initialize proves process readiness only. Require the later system/init native
UUID and both assistant/result input UUID echoes before recording compatibility.
Command lifecycle and rate-limit telemetry provide no completion evidence.
No probe belongs inside a Store transaction or replaces the ordinary admitted
server path.

After owned cleanup, report only state entry names, types, modes, ownership,
link counts and sizes, plus process/endpoint cleanup counts. Do not export file
contents, account response payloads, token values or prompts. Only project JSONL history is remounted. Generated `.claude.json`, policy-limit
metadata, remote settings, backups and failed-event telemetry are preserved on
host storage but excluded from the next child's fresh bounded `/account` tmpfs.
Their closed observed names/types are validated without reading their contents.
Unknown files, symlinks, multiply-linked files, foreign workspace directories,
foreign requested session transcripts and excessive size/count refuse.

`profile.exec_resume(selected_account, resume_spec)` consumes an exact private
`claude_resume.ResumeSpec` bound to that profile, validates the selected native
transcript, then uses fixed `--resume` instead of `--session-id`. There is no raw
resume UUID parameter or failed-resume fallback. The trusted parent bootstrap
may construct this private spec only through the existing inherited resume pipe
contract after its issued accepted-session grant and prior-tree reap proof.
The spec and filesystem existence are not Core authority. A fresh selected
account capability, process, namespace, FD handoff and local lineage are required
for each turn. Missing transcript or failed launch never returns the spec.

A synthetic two-process namespace test proves session metadata survives while
generated account metadata is excluded and remains unchanged on disk. The
credential memfd is absent from native descriptors; no selected token appears
in persisted synthetic history. Closed workspace/session, alias and fixed resume
flag regressions supplement that actual process test.
This does not qualify actual Claude persistence or authenticated egress.
