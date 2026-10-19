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
