# Staged canonical OXRM exact-scope status ABI v1

This is a prepared additive leaf for canonical repository **otcan/oxrm**, whose
MCP owner is `apps/mcp/src/server.ts:buildMcpHttpServer`. It is not an implemented
canonical endpoint. Migration owns only the staged leaf
`v2/migration/oxrm_scope_status/canonical_scope_status.ts` and tests; the canonical
OXRM specialist owns adoption and its caller-auth boundary. Orkestr coordinator
owns subsequent native registration; UI must wait for a reviewed mounted ABI.
No Core schema change is required, and existing OXRM handlers are untouched.

## Exact source seam

The reviewed OXRM `apps/mcp/src/config.ts:loadConfig` already constructs optional
`linkedinOutreachScope` from the two configured scope names, refusing partial
configuration. The canonical `packages/core/src/services.ts:createCrmServices`
uses that pair for `requireConfiguredOutreachScope`, `assertClaimScope`,
`assertLinkedInOutreachScope` and `assertReadScopeForLeadQuery`. API and MCP
bootstrap pass it into the service constructor. A status response must report
this configuration, not infer it from records or generic health/deployment.

Source review found **no request caller-auth hook** in the inspected API/MCP
server/config files. Consequently no current authenticated status caller can be
asserted from these files. A loopback socket or deployment scope is not a
principal. The staged leaf therefore requires an explicit `authenticate`
function and supplies no anonymous, registry-owner, host-operator or V2-owner-ID
fallback. This is the exact missing canonical integration port.

Proposed canonical target: new `apps/mcp/src/scope-status.ts`, with a tiny
bootstrap call in `buildMcpHttpServer` after `loadConfig` and service construction.
The prepared module has no imports or operational service calls. It accepts:

```typescript
createScopeStatus({
  configuredScope: config.linkedinOutreachScope,
  authenticate: currentRequestStatusPrincipal,
  serviceSurface: tools.services
})
```

`currentRequestStatusPrincipal(request)` must verify the original current
canonical caller without refresh, initialization or mutation, returning
`{ subject, scope: { outreachWorkspaceId, linkedinAccountAlias },
canReadScopeStatus: true }` or null. It is called twice with the same original
request. Its subject and exact pair must remain equal. Exceptions, logout,
revocation or owner change refuse. Neither query nor registry data constructs
this principal. V2 browser credentials must not simply be forwarded to OXRM or
assumed to share identities; any cross-service binding must be explicit and
owned by the canonical auth implementation. Pre/post checks do not make network
delivery atomic with revocation.

The handler returns `{statusCode, headers, body}`; the canonical Fastify wrapper
passes its request unchanged and applies all three fields to the reply. This is
a small registration seam, not permission to mount an unauthenticated stub.

## Proposed HTTP contract — unregistered

GET `/status/linkedin-outreach` requires exactly one query parameter each:
`outreachWorkspaceId` and `linkedinAccountAlias`. No other keys, duplicate keys,
request bodies or partial scope are accepted. Only the exact configured pair
and the authenticated principal's exact permitted pair can succeed. The route
has no tool call, DB query, environment lookup, provider call or file access.

Successful example with fake scope:

```json
{
  "format_version": 1,
  "status": "scope_attested",
  "scope": {
    "outreachWorkspaceId": "workspace-example",
    "linkedinAccountAlias": "account-example"
  },
  "coverage": {
    "scope_configuration": "attested",
    "capabilities": {
      "recipient_claim": {"availability": "callable_surface_present", "behavioral_assurance": "not_exercised"},
      "outcome_recording": {"availability": "callable_surface_present", "behavioral_assurance": "not_exercised"},
      "scoped_lead_query": {"availability": "callable_surface_present", "behavioral_assurance": "not_exercised"}
    }
  },
  "activity_proven": false,
  "workflow_ready": false
}
```

Coverage names are grounded in actual service symbols, inspected without calling
them: `claimOutreachRecipients`, `recordOutreachEvent`, `listXrmRecords`. The
first is exposed through API POST `/api/outreach/claims`; outcome recording uses
POST `/api/outreach-events`. This status handler never invokes either. It does
not claim the MCP route exposes all those operations. Own callable data
properties produce `callable_surface_present`; missing, inherited or accessor
properties produce `not_observed`, never `absent`. Accessors are not evaluated.
Neither result proves DB health, per-operation authorization, record filtering,
claim correctness, send approval, provider readiness or actual feature use.
Behavioral assurance remains `not_exercised` for every capability.

All leaf responses set no-store and nosniff. Refusal envelope:
`{format_version:1,status:"refused",error:<fixed-code>}`.

| HTTP | Code | Meaning |
| --- | --- | --- |
| 400 | request_invalid / scope_required | malformed/bodied/partial/duplicate scope request |
| 401 | authentication_required | missing/revoked caller or no status-read permission |
| 403 | scope_mismatch / caller_changed | wrong pair or changed current principal |
| 404 | status_transport_unsupported | wrong route/origin/fragment |
| 405 | method_not_allowed | non-GET |
| 409 | scope_not_configured | configured pair missing or invalid; unresolved |
| 503 | authority_unavailable | current verifier failed; no fallback |

Public V2 presentation must not expose raw canonical scope or endpoints. A
future owner-scoped native bridge must compare both returned scope components
with its trusted binding and expose only fixed coverage/refusal categories.
A future bridge must not upgrade the existing health-only v1 DTO silently.
No returned state authorizes contact reads or actions. No failure means unused.

## Evidence and remaining acceptance

The prepared leaf has eight Node type-stripped synthetic tests covering exact
pair, foreign/unauthenticated callers, missing configuration, both current-auth
checks, query/body refusal, no accessor evaluation, frozen configuration and
mandatory verifier. Traps prove no operational callable is invoked. These are
leaf tests, not canonical Fastify/native integration or TypeScript typechecking.

Private discovery evidence retains the inspected working-source hashes; the
checkout has local changes and its HEAD alone is not a source pin. Neither
source discovery nor tests made a live service call. No records, credentials,
contact/message state or mirrors were accessed or copied.

Smallest next owner assignment: canonical OXRM specialist supplies the actual
request-bound read-only verifier and adopts this isolated handler, then runs
Fastify injection tests for two separately scoped principals, missing/foreign
scope, revoke/logout between checks and zero service calls. Coordinator then
implements the native original-browser-session bridge against that pinned
canonical source. Until that port exists, exact-scope live parity remains
unresolved and all nine workflow requirements remain preserved.

## Original-request verifier adapter checkpoint

`v2/migration/oxrm_scope_status/fastify_scope_status.ts` stages
`registerScopeStatus(app, dependencies, verifyCurrentCaller)`. It is not mounted.
`CanonicalCallerVerifier` receives the original `FastifyRequest` on both checks,
including the framework request identity; the pure handler's request projection
is never used to reconstruct credential authority. Missing verifier fails at
registration; null current principal refuses 401; verifier exceptions refuse
503. A changed caller/scope refuses. Successful metadata remains explicitly
not workflow readiness or activity proof. Delivery checks do not establish an
atomic response/revocation boundary.

Read-only canonical source review found scope enforcement in
`packages/core/src/services.ts` (`assertLinkedInOutreachScope`,
`assertReadScopeForLeadQuery`, `assertClaimScope`), but no caller credential
verifier in the reviewed API/MCP/core TypeScript trees. MCP `loadConfig` supplies
configured scope, not caller authentication. `packages/db/src/schema/index.ts`
`integrationAccounts` stores connector status and credential references; it is
not an authenticated human/machine caller or workspace-membership authority.
The generic Compose source binds API/MCP ports to loopback; this is transport
exposure configuration, not a caller principal. These findings do not rule out
an external deployment authentication boundary; none was attested by this
source review. No deployment secret, integration-account row or credential
reference was read.

The exact missing integration is a canonical-owner-supplied
`verifyCurrentCaller(originalFastifyRequest) -> Promise<StatusPrincipal|null>`
backed by its **current credential/session authority**, with explicit status-read
permission and exact workspace/account authorization. It must validate the
original credential on both invocations, without refresh or initialization.
Configured scope, registry data, loopback, arbitrary identity headers and V2
owner UUIDs cannot supply that authority. If authentication is external, the
canonical owner must first identify and attest its authenticated transport and
principal-binding contract; this adapter must remain unmounted until then.
Smallest next ownership slice: canonical service/auth owner implements that
verifier and its revocation/scope tests; coordinator registers this adapter only
after review. No new authority database is proposed by Migration.

Executed isolated qualification with existing Fastify 5.8.5, TypeScript 5.9.3
and Node 22.23.1: strict NodeNext/ES2023 compilation with
`noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` PASS; five actual
Fastify injection tests PASS (original-request retention, claimed-header denial,
foreign scope, post-check logout/revoke, changed caller/authority failure).
Eight unchanged pure handler tests PASS. No package install or canonical-source
edit. Initial harness execution stopped because a root-owned compiler output
prevented copying the test file; copying into that disposable output with its
owner corrected the harness, without source changes. This is synthetic adapter
qualification, not proof of a real credential verifier or canonical deployment.
Live endpoint calls and canonical registration remain **unexecuted**.

To reproduce in a disposable package with those dependencies already available,
compile both TypeScript leaf files with the flags above, copy the `.test.mjs`
fixture beside the emitted files while changing its import suffix from `.ts`
to `.js`, then run `node --test fastify_scope_status.test.mjs`. No manifest or
lockfile changes are required in the product repository.
