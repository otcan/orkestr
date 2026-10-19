# Canonical opt-in Basic status wiring

Canonical oXRM review branch `feat/scoped-status-basic-verifier`, commit
`40ce5ebcc7b9197ab1604425bf20c144e9672370`, is based on clean source
`927d891efa9ab1019b84a5ef1e329b07598f1dfb`. Work was isolated from the existing
dirty checkout. No canonical deployment, configuration or live data was changed.
The canonical branch is local for independent review, not pushed or deployed.

Canonical files now provide actual host Python bcrypt verification, explicit
current grant loading, ordinary Fastify construction and exact Caddy status-path
forwarding. No schema, manifest, lockfile or credential storage was added.
The route is absent by default. Its opt-in requires existing admin credential
configuration plus an explicit private exact user/subject/workspace/account grant;
no existing private grant was discovered or inferred. See canonical
`apps/mcp/src/SCOPED_STATUS.md` for the complete configuration and limits.

The backend uses installed Python bcrypt (qualification version 3.2.2), stdin
only, no shell, a 3-second timeout and bounded output. Costs 4..14 and passwords
up to 72 UTF-8 bytes are accepted; others refuse. Runtime packaging must review
and provision a supported maintained bcrypt release. No dependency was downloaded.
No deprecated crypt fallback is used. Current authority is read before and after
hash verification; the outer status leaf repeats current authentication before
delivery. No client-supplied principal or identity header grants permission.

Explicit limitations: Basic has no browser session logout; runtime environment
credential/grant changes generally require controlled process restart. This
patch is not an external live revocation service. Pre/post checks are not atomic
response/revocation. Canonical service methods are never invoked by status.
The clean canonical base predates unrelated dirty scope-enforcement changes;
metadata callable presence is not operational scope verification or readiness.

Author qualification: strict isolated NodeNext TypeScript PASS; five new tests
PASS with actual bcrypt correct/wrong-password checks, malformed/oversize refusal,
explicit loader scopes, actual Fastify injection, disabled route and current
rotation/revocation. Only synthetic credentials were used. Previously completed
ded4 tests were not rerun. Full canonical build, active proxy acceptance, actual
credential tests, deployment and live connector calls remain **unexecuted**.
Private receipt binds commands, raw logs, dependencies and tested/committed source
hashes. Two copied leaf comments were clarified after qualification; executable
TypeScript was unchanged. Independent review is required before activation.

Remaining concrete integration input is the reviewed private scope grant and
operator-provisioned credential/hash environment for MCP, plus supported bcrypt
packaging. Shared service operation and deployment remain canonical-owner work;
this patch implements the loader/backend/mount rather than leaving those as
unwritten adapter responsibilities.

## Full canonical build successor evidence

The previously unexecuted full canonical build was subsequently executed on exact
`40ce5ebcc7b9197ab1604425bf20c144e9672370` in its isolated worktree:
`COREPACK_ENABLE_NETWORK=0 PNPM_PACKAGE_MANAGER_STRICT=true pnpm run build`.
Existing installed dependencies were linked into the isolated tree; workspace
package links were rebased to isolated source. No dependency download was
observed. pnpm 11.6.0 reported its already-up-to-date dependency synchronization;
tracked manifests and lockfile stayed unchanged. Full recursive build PASS:
shared, DB, core, API, MCP, CLI, backup, scheduler, worker and Angular web.
No source errors or baseline build failures were encountered; no fix was needed.
The isolated tree remained clean. Original dirty checkout's tracked/untracked
path set was unchanged; build output was generated only in the isolated tree.
Raw log and compiled-output hashes are retained in the private full-build receipt.
No process using these new artifacts was launched.

A separate bounded process-environment **key-name presence only** census checked
approved scoped-status/admin/scope configuration names for Node/Caddy processes.
No secret values were decoded, compared, hashed or persisted. No explicit status
grant key was observed in that census. This is not proof of global absence or
instance-specific effective configuration: process lifetime and enumeration are
not coherent, and file/secret-store configuration was not read. No private grant
was fabricated or service enabled. Canonical review and effective private grant
configuration remain prerequisites to any deployment/live acceptance.

## Independent-review subprocess blocker repair

Canonical successor `491c8a8feaf954ae795380815d331fde96524ad0` repairs the
reviewed aggregate-process and stdin-cleanup defect in predecessor 40ce. A new
purpose-specific `bcrypt-worker.ts` owns a shared production pool of four children
with zero queue. Saturation fails closed immediately. Failure/timeout kills the
child; admission and pending result remain held until child `close`. Early stdin
failure no longer clears the watchdog while leaving a live child unjoined.
Synchronous spawn exceptions release admission because no child exists.

Exact successor qualification: full canonical recursive build PASS and ten
compiled tests PASS (five actual bcrypt/route regressions plus five injected
worker-lifecycle cases). Injected cases cover saturation/reuse, stdin failure
without premature settlement or admission release, timeout kill/join, process
failure/oversize output, synchronous spawn failure and invalid bounds. Diff check
PASS. No source errors required a subsequent fix. Original 40ce logs remain
unchanged and do not confer successor credit. New raw logs, source/artifact
hashes and commands have a separate private repair receipt. Canonical branch is
local for independent review; no deployment, activation or credential access.
