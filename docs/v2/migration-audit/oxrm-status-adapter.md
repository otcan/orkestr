# Canonical OXRM transport status adapter v1

Ownership: Migration owns the isolated `v2/migration/oxrm_status.py` adapter and
its synthetic tests. UI/Core should consume only this explicit coverage contract;
no UI consumer, native owner-auth binding or shared router is registered here.
Google registry metadata is a separate contract and authority.

## Reviewed source and supported transport

The canonical OXRM source has a supported `GET /health` handler in
`apps/mcp/src/server.ts:266` (`buildMcpHttpServer`). It returns status `ok`,
service `oxrm-mcp`, product and deployment metadata. It does not return configured
workspace/account scope, capability availability, authentication readiness or
activity. `packages/shared/src/index.ts:18` (`oxrmDeploymentInfoFromEnv`) constructs
deployment metadata, which is not a scope attestation. The MCP server initializes
its tools during bootstrap; the health handler itself invokes no operational tool.

The inspected checkout HEAD was `927d891efa9ab1019b84a5ef1e329b07598f1dfb` with
local modifications. The actual reviewed MCP source SHA256 is
`72e30b9325d656ace9f5b9f59cbba1ea1ba04890af91e1c1414d83bf8ba2b981`;
HEAD alone does not pin that working source or prove the deployed binary matches.
Private source-discovery evidence retains hashes for the other reviewed files.
No endpoint was called to infer deployment correspondence.

API `GET /api/health` in `apps/api/src/server.ts:340` delegates to
`packages/core/src/services.ts:2467` (`health`), which queries backup-health
metadata via `getBackupHealth`; it also lacks exact-scope attestation. This
adapter deliberately uses only the narrower MCP health handler. It never calls
`/mcp`, enumerates tools, selects records, or invokes contact/message operations.

Orkestr's existing `packages/core/src/linkedin-outreach-scope.js` binding and
`docs/linkedin-outreach-scope.md` require both workspace and account identities;
endpoint reachability alone cannot satisfy that operational contract. No scope
is inferred from campaigns, names, returned records or generic deployment IDs.

## Explicit trusted adapter ABI

`Binding(owner, workspace, account, endpoint_id, mcp_endpoint)` is immutable trusted
configuration. All identity components are mandatory; the endpoint has an exact
`/mcp` path and no credentials, query or fragment. A catalog refuses duplicate
owners, shared origins or repeated workspace/account pairs instead of selecting a
fallback. The request cannot supply an owner, endpoint, path or scope override.
Private bindings never belong in this repository.

`StatusAdapter(bindings, transport=read_health).observe(verifier)` rechecks the
original ordinary-account authority before selection, before transport and after
transport. The request-bound verifier must use the native current browser session
Store authority; a registry identity is never authentication. Missing, changed or
revoked owners refuse. Pre/post verification is not atomic response/revocation.
The verifier seam is not yet a mounted native Store integration.

`read_health` performs one bounded GET on `/health` at the explicitly bound MCP
origin, using a two-second socket timeout, default TLS verification, no proxy-env
lookup, cookies, Authorization, redirect following or token acquisition. The
response cap is 16 KiB; encoded/compressed bodies and oversized/truncated declared
bodies refuse. The transport does not initialize directories or read files.
Construction performs no network request. Live invocation remains separately
held pending canonical owner mapping and source/deployment review.

Successful output contains only these fixed fields:

```json
{
  "format_version": 1,
  "status": "transport_observed",
  "transport": "canonical_mcp_health",
  "health": "ok",
  "binding": "explicit_owner_workspace_account",
  "scope_coverage": "not_exposed_by_reviewed_transport",
  "capability_coverage": "not_exposed_by_reviewed_transport",
  "activity_proven": false,
  "workflow_ready": false
}
```

No endpoint, workspace/account identity, deployment field or arbitrary upstream
string is returned. Even an unexpected upstream scope field cannot silently
upgrade the reviewed contract. Duplicate JSON keys and nonfinite values refuse.

`Refused` exposes only a fixed code: `authentication_required`,
`authority_unavailable`, `owner_scope_changed`, `binding_unavailable`,
`upstream_access_denied` (401/403), `status_transport_unsupported` (404),
`upstream_unavailable` (transport/other status), or `response_invalid`.
Forbidden/wrong-scope/unsupported never mean absent or unused. No configured
binding and no successful status observation leaves the workflow unresolved.

## Acceptance and smallest remaining implementation

Eight independent synthetic tests exercise two-owner exact dispatch, no global
fallback, logout/change before and after transport, ambiguous bindings, unsafe
URLs, explicit refusal classes, malformed/duplicate/oversized data, and an actual
loopback HTTP server proving exact GET/no credentials/no redirect/response cap.
No canonical service, provider, token or real registry is read by tests.

Coordinator can bind the original browser credential to Store.authenticate for
this verifier, using an explicitly reviewed owner-to-canonical-scope catalog.
Before claiming exact-scope availability, the OXRM specialist must publish a
mutation-free authenticated scope-status handler that attests configured
workspace+account and fixed supported capability names without selecting records
or invoking tools. This is a missing external port, not a guessed URL or a Core
schema change. UI must keep readiness and scope unresolved for the current DTO.
The smallest subsequent acceptance is two distinct scoped fake authorities plus
missing/foreign scope, current session revocation, and denied status; only a
separately authorized deployment-matched status observation can add live evidence.
All nine workflow requirements remain preserved; this is transport coverage only.
