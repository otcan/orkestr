# Offline registry hardening plan

`node scripts/security/registry-hardening.mjs --input /private/registry-review.json`
prints a JSON Patch and pending qualification checklist. It never contacts
Kubernetes, a registry, a credential provider or backup storage. It does not
apply patches, pull layers, create Secrets, push/delete images, perform garbage
collection or run mutation probes. Malformed/unreviewed input exits with code 2
and a bounded error code, without echoing input values.

The input contains `snapshot` and `review`. Optional `qualification` records
previously authorized evidence. Keep this file private; do not include Secret
objects, credentials, token values, application layers or backup contents.
`test/registry-hardening.test.js` contains a complete synthetic input factory.
Its UID, digest, paths, user IDs and resource values are test fixtures, not
recommended operational settings.

## Required reviewed input

The snapshot contains an `apps/v1` Deployment, its `v1` ClusterIP Service and
the complete namespace NetworkPolicy inventory. Only a single registry container
is supported; additional containers or init containers require separate review.
The reviewer must confirm the policy inventory is complete. Applicable ingress
allow policies are rejected because Kubernetes policies are additive.

Each review section needs `reviewed: true` and a non-secret `evidenceRef`:

| Section | Required decisions |
| --- | --- |
| `target` | Exact namespace, name, UID, resourceVersion and containerName |
| `templateHash` | `registrySnapshotHash(snapshot.deployment.spec.template)` |
| `image` / `compatibility` | Approved digest reference, exact source/target image, Distribution environment-variable contract, tested non-root IDs, read-only root compatibility, exact writable mount paths |
| `storage` | Hash of existing `{volumes, mounts}`, persistent volume name/path, verified permissions and scratch-write coverage, no manually mounted service-account credentials |
| `exposure` | Hash of `{service, networkPolicies}`, complete policy inventory, reviewed loopback access and public IPv4/IPv6 denial |
| `resources` | Measured/reviewed CPU and memory requests/limits; no default sizes are inferred |
| `auth` | Existing htpasswd Secret name/key, new volume name and non-overlapping mount path, key/readability verification and staged credential references for every intended consumer |
| `deletion` | Explicit decision to disable deletion |
| `rollout` | Reviewed maintenance-window and private rollback-snapshot references; no canary mutation permission inferred |
| `recovery` | Approved immutable off-host destination and isolated-restore plan references |

Hashes use the exported `registrySnapshotHash` function, which sorts object keys
and preserves array order. A hash binds the evidence to supplied data; it is not
proof that the data came from a live authorized inventory.

## Patch and qualification boundary

The patch tests UID and resourceVersion before any write. Any rollout, operator
edit or concurrent change requires a fresh snapshot and review. The patch adds
explicit non-root IDs, RuntimeDefault seccomp, no privilege escalation,
drop-ALL capabilities, read-only root, CPU/memory controls and disabled token
automount. It adds a read-only Secret mount and the Distribution authentication
and deletion environment controls. It preserves existing storage volumes and
mounts, unrelated environment/resource settings, ports, Service and policies.
The reviewed Secret file must be readable by the chosen non-root identity;
the planner does not change persistent-volume ownership.

Apply only through the separately authorized deployment workflow, including
server-side dry run and rollout observation. The generated artifact grants no
permission to probe registry mutations or pull application layers. A rollback
must use the private pre-change snapshot with a new exact version precondition;
the planner deliberately does not print original environment values.

Qualification stays `pending` until evidence references cover every listed
check, the exact plan hash/UID/digest, a post-rollout resourceVersion and an
observation within 24 hours. This includes unaffected exposure layers,
unauthenticated mutation denial, intended-consumer digest readability,
immutable off-host backup freshness and an isolated restore. A complete input
reports `recorded_evidence_complete`, explicitly labeled as operator-supplied
evidence. The offline tool does not verify those external facts or claim a
successful rollout, authentication test, image pull or restore.
