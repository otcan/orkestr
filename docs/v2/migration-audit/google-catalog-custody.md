# Explicit Google metadata catalog

The ordinary server mounts the passive registry metadata route with an empty
catalog by default. `ORKESTR_V2_GOOGLE_CATALOG` optionally names one absolute
private operator descriptor, loaded once before the startup marker. Malformed or
insecure configured descriptors refuse startup; absence does not search registries.

The descriptor is bounded to 64 KiB and 128 bindings. Its closed JSON shape is:

```json
{"format":"orkestr-google-registry-catalog-v1","bindings":[{"owner":"11111111-1111-4111-8111-111111111111","legacy_registry_owner":"synthetic-legacy-owner","path":"/operator/registries/google-workspace-connections.json","identity_binding_reviewed":true}]}
```

The owner must be the persisted V2 owner, explicitly bound by an operator to the
separately reviewed legacy owner and exact registry path. The review boolean is
an operator assertion, not proof extracted from registry authentication fields.
Duplicate owners, paths, JSON keys, unknown fields and unreviewed entries refuse.
No caller can select a binding, path or legacy identity. No tokens are opened.

Linux only: the file must be root-owned, regular, single-linked, not world
accessible, and not group writable. A private read group may give the service
access (for example mode 0640). Every ancestor must be root-owned and not group
or world writable; symlinks at every component refuse. Reads are descriptor-held,
bounded and checked for metadata stability. This assumes a stable trusted local
namespace; hostile root/mount replacement is outside this profile. The catalog
is immutable until process replacement; no live rotation/revocation claim is made.

Registry reads still perform original browser Store authentication before
selection, before read and before response. Pre/post checks do not serialize
response delivery with revocation. A missing owner mapping is unavailable, never
connector absence. Counts describe configuration, not provider readiness/activity.
Outer guard/framework refusals retain their ordinary response format and may
preempt the leaf's no-store envelope. No shared error-header guarantee is added.

Validation runs the existing four real Store/Axum leaf cases through the actual
ordinary guarded router, plus descriptor parser/refusal cases. Private mapping
custody, positive root-owned filesystem provisioning, immutable package bootstrap
and live registry/browser acceptance remain separate operator qualification.
