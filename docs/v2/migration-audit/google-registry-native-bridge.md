# Native Google registry metadata integration seam

The isolated server leaf is `v2/apps/server/src/google_registry_metadata/`.
It implements the passive status-v1 DTO in `google-registry-request-contract.md`;
it does not register itself or establish connector readiness.

Coordinator registration requires only a module declaration and merging
`google_registry_metadata::router(catalog)` before ordinary `crate::guard` and
AppState layers. The trusted caller constructs `RegistryCatalog::new` from
explicit `RegistryBinding { owner, legacy_registry_owner, path }` entries.
An owner is the persisted V2 OwnerId. The legacy owner is a separately verified
registry identity, not an assumed equivalent ID. Neither binding nor path can
come from the request or registry authentication fields. No default catalog,
global fallback, or account provisioning is supplied.

The GET route remains `/api/v2/connectors/google/registry-metadata`. The leaf
reuses `browser::credential` unchanged and authenticates the original
`browser:<cookie>` using Store.authenticate for selection, immediately before
reading, and immediately before returning metadata. Bearer authentication is
refused. Host must equal the configured authority; an Origin, if supplied, must
equal the configured origin. Query, body and owner/path override headers are
refused. GET grants no action authority; browser logout retains ordinary
Origin/CSRF protection.

The native Linux reader opens each path component without following symlinks,
reads only the bounded named registry, refuses hardlinks and concurrent file
metadata changes, and rejects duplicate JSON keys. Unsupported platforms fail
closed. No connector helper, token lookup, subprocess, initialization, refresh,
provider request or directory creation occurs in the product reader. Only fixed
aggregate counters leave it; account identifiers and arbitrary strings do not.
A stable file read is not a cross-authority snapshot or proof of current use.

Leaf responses set no-store and nosniff. Existing ordinary guard/framework
refusals can preempt the version-1 leaf error envelope (including foreign Origin
and oversized bodies); clients must also handle ordinary HTTP refusals. The
existing guard returns early for some errors, so universal no-store on those
errors requires coordinator-owned outer response policy, not a leaf claim.
Authentication before delivery is not atomic with network delivery/revocation.

The Linux tests mount the leaf and real browser logout under the ordinary guard,
use two separately provisioned Store databases (the schema permits one owner per
database), and distinct explicit legacy bindings. They cover cookie scope,
Bearer/duplicate refusal, Host/Origin, missing descriptors/files, foreign source
owners, duplicate JSON, oversize and symlinks. Test-only barriers revoke/logout
before read and before delivery. No unsupported second-owner SQL insertion or
authentication stub is used. Native tests passed 4/4 on the exact `65e7730298afefae0812cd98455f7c9d9ec5973e`
composition with leaf `5e41617fdfa570a87b3ed269216adaea6d9b8acf` and temporary
public module declaration only. Strict server all-targets Clippy with
`orkestr-v2-store-sqlite/fixture-test-controls` and `-D warnings` passed using
locked/offline mandatory-wrapper execution. The first temporary declaration was
placed before the crate doc comment and failed E0753; correcting its placement
required no leaf change. Initial failure and final raw logs are retained privately.
The final selected test rerun passed 4/4 in 1.70 seconds. This qualifies synthetic
native composition, not canonical registration, live bindings or provider readiness.

A disposable integration build needs this subtree, the committed status-v1
fixture and a temporary module declaration only, on a coordinator-pinned current
server candidate. Run selected `google_registry_metadata::tests` and strict
server lint using the admitted wrapper. Shared registration, trusted private
binding configuration and any universal refusal-header policy remain coordinator
work. No schema, manifest or lock changes are required.
