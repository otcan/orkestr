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
