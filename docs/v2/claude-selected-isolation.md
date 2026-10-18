# Opt-in selected Claude isolation

`isolation.claude_selected.SelectedClaudeProfile(private_configuration)` uses the
same root-immutable native/supervisor/egress validation and fixed namespace,
resource, syscall and exact CONNECT proxy policy as the Codex authenticated
profile. Private format `orkestr-v2-claude-isolated-v1` has exactly format, native,
state_root, egress_socket, supervisor, hosts, workspace. No auth path, token,
account selector, environment override or billing configuration is accepted.
State must be a fresh empty private role directory. Resume is unavailable here.

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
stream-JSON first-turn profile. Actual native flags/metadata handshake must still
be qualified inside this profile. Control initialize ACK is process readiness
only; the separate Core requested-native/verified-native contract remains open.
The selected-account callback and executable wrapper remain root-private and
must be independently reviewed/staged; no actual selected-account launch was run
by this lane. Inventory now includes claude_selected.py (eight files total).

Synthetic tests use only a fake token. An actual namespace process verifies its
single selected environment, absence of unrelated inherited secrets/API keys,
empty private state, closed credential FD and denied direct Unix/external socket
access. Existing exact-host synthetic proxy tests cover permitted egress; no
real DNS, authentication or inference request is made. Parent-controlled path
and concurrent-replacement assumptions remain those of the authenticated profile.

## Immutable compatibility probe handoff

Stage exactly the eight files and SHA-256 values in
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
contents, account response payloads, token values or prompts. The initial
profile still requires fresh state: actual generated persistence layout is a
prerequisite for the closed restart validator and isolated resume entry. A
synthetic namespace test proves writable session metadata survives child exit,
the credential memfd is absent from native descriptors, and the selected token
is absent from that persisted fixture; it also proves reuse currently refuses.
This does not qualify actual Claude persistence or authenticated egress.
