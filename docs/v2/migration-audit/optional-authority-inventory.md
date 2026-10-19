# Optional authority inventory and implementation handoff

This is a source-reviewed boundary inventory, not connector execution or proof of
non-use. Private deployment selectors, bindings and status receipts remain in the
private overlay. Preserve all three workflows until their scoped acceptance is
complete. No connector, credential, contact or message export is proposed here.

## Existing source contracts

Memory: `packages/core/src/personal-agent-capability.js::ownerRequired` accepts
an authenticated admin **user** principal and rejects machine/anonymous callers.
`personalAgentCapability` checks authorization before feature/storage state;
HTTP 403 therefore says nothing about absence. Its storage readiness checks only
`personal_agent_projects` and `personal_agent_tasks`, not memory records.
`personal-agent-feature.js::personalAgentFeature` defaults off.
`personal-agent-memory-sqlite.js::openPersonalAgentMemoryStore` binds the
`personal_agent_memories` table through the jobs database initializer; do not call
that opener for a census. `personal-agent-memory-service.js::authorize` requires
the exact bound owner and feature flag. Its propose/create/correct/forget/retrieve/
context/export operations are service functions, not an established memory HTTP
route. `docs/product/personal-agent-memory-service.md` defines explicit consent,
provenance, scope and deletion semantics. Inert V2 history is not memory consent.

Google mail/calendar: `packages/connectors/src/connector-storage.js` defines
`scopedPrincipalUserId`: admin-like callers resolve the global scope; ordinary
users resolve their own scope, with an explicit tenant-runtime exception.
`connectorScopePaths` calls `ensureDataDirs` and creates scoped directories.
`google-workspace-connections.js::listGoogleWorkspaceConnections` calls
`repository`, which invokes `migrateLegacyGoogleWorkspaceConnection`: it may
read/write encrypted credentials, update a registry and remove a legacy file.
Consequently `GET /api/connectors/gmail/accounts` is excluded from inert inventory.
The fixed capability/health fields of the known nonsecret registry describe
configuration only, with neither freshness nor user-scope completeness assured.
Do not call list/refresh/token helpers to obtain metadata. Calendar capability
must be distinguished from Gmail; one does not imply the other.

OXRM: `thread-resource-policy-constants.js` defines resource type `oxrm` and
separate discover/read/write/execute actions; `thread-resource-policy-model.js`
defaults to shadow policy. `thread-resource-backfill.js` references are not live
authorization. The canonical operator authority requires an exact workspace and
account scope, with no local contact/conversation mirror or fallback. Those
private bindings are not product defaults. A reference or healthy host does not
prove the caller's canonical scope, read capability or current workflow activity.
No reviewed content-free canonical status endpoint was established in this slice;
contact-list endpoints are not acceptable substitutes.

## Smallest implementation assignments

| Workflow | Existing V2 seam | Missing owned slice | Minimum synthetic acceptance |
|---|---|---|---|
| Memory | Current owner authentication, project scopes and inert provenance | Memory/Core specialist: pure owner-bound capability adapter first, then separately authorized consent-aware service port; no automatic ingestion or historical auto-trust | Machine/foreign owner refuses; disabled and storage-unavailable differ; capability success does not attest a memory table; correction/forget require fresh consent and preserve scope |
| Gmail/calendar | Current owner auth and execution capability infrastructure | Connector specialist: mutation-free registry metadata projection under explicit caller scope; separate fresh connection setup and separately gated read operations | Fixture adapter performs zero initializer/token/refresh calls; foreign scope refuses; Gmail and calendar buckets independent; revoked/unknown/403 never become absent or ready |
| OXRM | Resource references and generic capability/auth boundary | Canonical OXRM specialist: content-free exact-scope status/reference adapter using the authority's supported principal; no local state mirror | Fake canonical service validates both scope components; wrong scope/403/timeout remains unresolved; revocation refuses; zero contact/message operations or outbound calls |

These are implementation seams, not registered routes or invented Store APIs.
Core owns shared contracts/schema; specialists own connector transports. Migration
owns the pure evidence classifier and can supply fixture adapters after the
supported status ABI is pinned. A specialist must establish the actual canonical
OXRM status caller/port before a live readiness claim. An owner-session Memory
status cannot be replaced with host-operator impersonation.

`v2/migration/optional_authority_inventory.py::classify` uses only fixed projected
flags/statuses. It never retains response fields or identifiers. HTTP 401, 403 and
404 remain distinct unresolved boundaries; a scoped 200 capability is still not
activity evidence. All classifications preserve the workflow and prohibit
credential migration. Its tests are synthetic classification tests, not connector
or privacy-scanner acceptance. No live content operations were executed.
