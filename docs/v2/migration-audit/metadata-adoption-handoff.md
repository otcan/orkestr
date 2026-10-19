# Passive metadata adoption: exact remaining ownership

## Canonical OXRM

Local canonical branch `feat/scoped-status-basic-verifier` successor
`6036b1685b9f953ef1c2bd7c4d36ae5f855bf4ca` adds only the focused original-caller
acceptance fixture and disabled-adoption instructions to reviewed worker-cap
source `491c8a8feaf954ae795380815d331fde96524ad0`. Runtime code is unchanged.
Three new tests PASS against the already built 491 runtime: original Basic caller
and exact granted scope only; current grant revoke/subject change before delivery;
missing/disabled grant cannot be supplied or enabled through a request. All
credentials/grants are synthetic in-memory fixtures. Prior full-build and ten-test
counts remain separately attributed; no broad suite rerun or new full-build claim.

Canonical owner next files are already implemented: `apps/mcp/src/server.ts`
mounts `mountBasicScopeStatus`, `basic-status-runtime.ts` loads current explicit
grant and calls the shared bounded bcrypt backend, and `infra/proxy/Caddyfile`
forwards the exact status route under existing Basic protection. The remaining
input is reviewed private credential/grant runtime configuration and runtime
bcrypt packaging, not an unwritten verifier or mount. Keep enablement absent
until review. No private grant was read/invented; source fixture is not deployment
acceptance. Process-lifecycle rotation and Basic's lack of logout semantics remain
explicit limitations. No service activation is part of this handoff.

## Native Google registry metadata

Qualified leaf source: `5e41617fdfa570a87b3ed269216adaea6d9b8acf`;
`v2/apps/server/src/google_registry_metadata/mod.rs` already exports:

- `RegistryBinding { owner: OwnerId, legacy_registry_owner: String, path: PathBuf }`
- `RegistryCatalog::new(Vec<RegistryBinding>) -> Result<RegistryCatalog, &'static str>`
- `router(RegistryCatalog) -> Router<AppState>`
- route `/api/v2/connectors/google/registry-metadata` (GET only).

The constructor checks explicit unique owner/path mappings and fixed registry
basename. It does not load operator configuration or attest owner equivalence.
Missing owner entry returns `registry_unavailable`; no global registry fallback.
The original browser cookie goes through `Store.authenticate` for selection,
pre-read and pre-delivery. The caller supplies neither owner nor filesystem path.
Gmail/calendar remain separate aggregate counters, not readiness or activity.

**Coordinator/server bootstrap owner** owns the next concrete leaf:
`v2/apps/server/src/google_registry_metadata/catalog_config.rs` (proposed new
file; not yet implemented). Suggested API is
`load_private_catalog(path: &Path) -> Result<RegistryCatalog, CatalogConfigError>`.
It must accept only an explicitly supplied trusted operator descriptor, bounded
and duplicate-key rejecting, with private ownership/permission/no-symlink checks.
Each entry must explicitly bind persisted V2 OwnerId to separately reviewed legacy
registry owner and exact named registry path. Reject malformed, duplicate,
foreign/unattested or ambiguous entries; no environment-wide registry search,
identity inference, token lookup, init, directory creation or global default.
Config absent must stay empty/disabled. Descriptor format/config option is still
coordinator-owned proposal, not a published request or configuration ABI.
Private descriptor custody belongs to the operator outside OSS/credential data;
review must establish its scope mapping, not trust registry authentication fields.

**Coordinator shared integration** then adds module declaration in
`v2/apps/server/src/lib.rs`, supplies the catalog at ordinary bootstrap in
`v2/apps/server/src/main.rs`, and merges `google_registry_metadata::router(catalog)`
in the shared router before ordinary `guard`/state layers. Existing `router(state)`
needs an additive coordinator-owned catalog-taking composition (or equivalent
trusted state field); the leaf cannot install private config itself. Retain the
existing browser parser and Store authority. No request-controlled override.
Shared outer no-store policy must cover guard/framework early refusals if a
universal header guarantee is desired; leaf alone cannot promise that.

Smallest acceptance is default-empty refusal plus synthetic exact trusted binding
through the actual ordinary server bootstrap/router: two separately provisioned
owner Stores, foreign/absent binding, duplicate descriptor, cookie logout/revoke
before read/delivery, wrong Host/Origin and Bearer refusal. Existing four leaf
native tests do not replace that registration/config-custody acceptance. No schema,
manifest or lockfile change is necessary. UI consumes status-v1 only after matching
mounted source review; no provider calls, token migration or readiness claim.
