# Beta service configuration and discovery v1

The sole optional startup selector is `ORKESTR_V2_BETA_CONFIG`. It is mutually
exclusive with execution config/set and timers. The service packager supplies a
byte-pinned root-owned mode0640 file readable by the dedicated service group.
The HTTP child receives no inherited provider environment or token file override.
HOME, BIND, ORIGIN, UI_DIST and the bootstrap pipe remain explicit packaging inputs.

The closed JSON schema is `BetaConfig` in `apps/server/src/beta_config.rs`:
`schema_version` is 1; `owner_id` and `conversation_id` are nonnil UUIDs;
`manager_socket`, `launcher`, `workspace` are absolute paths;
`launcher_sha256` is lowercase64hex; `namespace` and `supervisor_key` are bounded
ASCII identifiers. No token, account selector, limits, role or provider field is
accepted. Only Codex Deep is supported. Paths are operator configuration, never
browser inputs. Validation of this shape alone does not authenticate files or
spawn a process. Startup must separately verify file custody, launcher digest,
workspace separation and exact manager-owned peer/process binding.

The manager socket speaks exactly c077b83e's canonical protocol v1, framed JSON
with an8192-byte maximum. The manager is root-owned; its process entrypoint,
private ledger paths, interpreter and startup closure remain manager-owned and
are not fields of this HTTP configuration. No environment/presence fallback
selects a provider. Descriptor workspace authority is not enabled by this schema.

Authenticated `GET /api/v2/beta` returns `BetaDiscovery` from contracts/beta.rs:
schema_version1, configured conversation_id, provider codex, role deep, controls
(stop,steer,accept booleans), fixed limits and optional canonical window status.
No owner credential, boot ID, native identity or path is returned. Controls are
sampled current availability, not authority; false remains truthful during
opening, uncertainty or unavailable live handles. UI must not infer provisioning.
Current browser authentication is checked before configuration discovery. An
unconfigured ordinary server returns 404 with code `beta_unconfigured`; it does
not invent a conversation or advertise execution controls.

`GET /api/v2/conversations/:id/window` reads canonical current window status.
POST accepts exactly Core's ExecutionWindowRequest and returns its immutable
ExecutionWindowAdmission. Existing durable message intake happens first. Each
additional input requires explicit Some(window_id) admission; it never resets a
budget, deadline or generation. Failed admission leaves durable input queued.
Both routes require current browser owner scope and existing Host/Origin/CSRF
policy. No configured-conversation fallback authorizes another conversation.

All manager-bound integers are checked before IPC: nonnegative and strictly
less than2^53, using integer serialization only. Out-of-range admission refuses
before any manager operation, never rounds or truncates.

After900 seconds provider attempts, reservations and bytes remain forbidden.
Core may retain AwaitingAcceptance and accept a later current-browser decision.
Post-deadline metadata-only manager retirement requires an explicit aligned
manager successor plus canonical terminal/Core retirement and the original typed
Runtime reap. Until then it remains reconciliation and cannot open a replacement.
Neither status, task completion nor an empty ChildSet supplies that proof.

This checkpoint publishes types and configuration grammar only. It does not
mount routes, activate a service, qualify a manager startup or authorize an
account invocation.
