# Capability selectors and remaining authority coverage

`v2/migration/capability_metadata.py::personal_agent_observation` is a pure,
fail-closed adapter for already-authorized responses from
`GET /api/personal-agent/capability`. It performs no request, authentication,
environment read or database open. Five synthetic tests cover all three exact
source responses, extra fields, malformed types, contradictory flags and changed
assistant shape. A changed source response requires explicit mapping review.
No raw API response or error should be logged when validation fails.

Source references: `apps/server/src/modules/personal-agent/personal-agent.controller.ts::capability`,
`packages/core/src/personal-agent-capability.js::personalAgentCapability/ownerRequired/personalAgentStorageReady`,
`packages/core/src/personal-agent-feature.js::personalAgentFeature`.
The capability requires an authenticated admin user, rejects anonymous/machine
auth, and gates its check on the feature flag. The only SQLite selector is
`select name from sqlite_master where type = 'table' and name in (?, ?)` with
fixed `personal_agent_projects` and `personal_agent_tasks` constants. DatabaseSync
uses readOnly. It checks table presence, not row activity or memory coverage;
storage_unavailable conflates missing files, missing tables and caught failures.
The assistant is always unavailable/not_configured in this reviewed source.
Do not synthesize an admin principal or enable the feature to obtain evidence.
A root-owned authenticated request may feed the adapter after independent review;
no actual API request, private receipt or availability claim exists for this edge.

## Timer and connector selectors

`packages/core/src/timers.js::timerCadences` defines once/daily/weekly/interval;
`listTimers` calls createTimerRepository.list then normalizeStoredTimer. Doctor
calls ensureDataDirs and probes prompt paths. These are not approved inert census
paths. A future authority-owned selector should count fixed cadence buckets,
boolean enabled states and validated target *classes* inside the authority,
without returning targets, names, prompts, paths, next-run timestamps or raw JSON.
Missing/malformed/unsupported values need separate buckets; persisted scheduling
metadata must not be called evidence of successful execution. No arbitrary timer
registry file reads or new SQL schema guesses are authorized by this proposal.

`packages/core/src/agent-job-store.js::schedule_state` stores job/trigger_index/
next_fire_at; its count is not an inventory of the independent timer registry.
Empty job-engine tables cannot establish that timers or daily workflows are unused.

`packages/connectors/src/google-workspace-connections.js::repository/migrateLegacyGoogleWorkspaceConnection`
can migrate legacy credentials while listing connections. Gmail account GET is
mutation-bearing and excluded from census, **not evidence of unavailable Gmail
or calendar**. Need an authority-owned fixed mail/calendar capability projection
that bypasses legacy migration, token reads/refresh, profile reads and connection
identity output. Do not enumerate accounts to construct it in this lane.

Remaining authorities: timer configuration/use, effective binding capabilities,
mail/calendar activity, personal/external memory and OXRM remain uncovered.
Thread runtime/role/binding-shape counts and fixed trigger/run buckets are actual
persisted observations, not active use or parity completion. Personal capability
availability will only add availability evidence, not close those gaps. Private
prior receipts and their actual counts remain outside this repository. Main
messaging holds and the personal skill-only router/autostart exclusion remain.

Dependency requests: an authorized safe capability response for this adapter;
timer/connector authority owners' fixed inert aggregate selectors; Core's dormant
provenance/apply/export ports described in dormant-provenance-contract.md.
