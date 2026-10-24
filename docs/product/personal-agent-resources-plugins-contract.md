# Personal Agent: project resources and Integration Hub, read-only contract v1

Status: **frozen read-only contract v1 (2026-10-18)** for ORK-563 (OP-27) and ORK-566 (OP-30). It follows ADR 0003 at `2d48f841`: self-hosted local baseline; external integrations are optional plugins.

**Implementation status:** none of the routes below exist in `main` yet. Clients must show an honest "not available yet" state until the capability endpoint advertises them (see Discovery), and must never call a route that is not advertised. Field names and enum values below are frozen: changes are additive, and renames need a v2 of this document.

## Discovery

`GET /api/personal-agent/capability` (existing) will gain an optional `features` object:

```json
{ "features": { "projectResources": false, "integrationHub": false } }
```

A missing `features` object, or a missing or `false` key, means not available: show the placeholder.

## Routes (planned, read-only)

| Method and path | Returns | Auth |
|---|---|---|
| `GET /api/personal-agent/projects/:projectId/resources` | `{ projectId, resources: ResourceBinding[] }` | Owner session |
| `GET /api/personal-agent/integrations` | `{ plugins: PluginPackage[], connections: Connection[] }` | Owner session |
| `GET /api/personal-agent/integrations/:pluginId` | `{ plugin: PluginPackage, connections: Connection[], capabilities: Capability[], bindings: InstanceBinding[] }` | Owner session |
| `GET /api/personal-agent/projects/:projectId/integrations` | `{ projectId, bindings: ProjectPluginBinding[] }`: effective, after inheritance and narrowing | Owner session |

**Rules for all routes:**
- Owner session only. Machine and agent credentials get `403`; agent read access to its own project's effective bindings is a later, separate decision.
- No secret material ever appears in these responses.
- Mutations (install, configure, enable, bind, provision, update, uninstall) are **out of scope for v1**. They will require an owner session, recent authentication and, where ADR 0003 says so, an approval. Clients must not offer them as working actions yet.

## Types

### ResourceBinding

| Field | Type | Notes |
|---|---|---|
| `id` | string | Opaque, stable |
| `projectId` | string | |
| `kind` | `local_git` \| `oxrm_workspace` \| `files` \| `desktop_pool` \| `github_repo` \| `jira_project` \| `whatsapp_conversation` \| `plugin_resource` | `local_git`, `oxrm_workspace`, `files` and `desktop_pool` form the local baseline |
| `source` | `local_baseline` \| `plugin` | |
| `pluginId`, `connectionId` | string or null | Set when `source = plugin` |
| `logicalId` | string | Orkestr-side identity |
| `externalId` | string or null | Provider identity once provisioned |
| `state` | `ProvisioningState` | |
| `blocker` | `{ code: BlockerCode, message, remedy: { action, hint } }` or null | Set when state is `needs_connection`, `needs_approval` or `failed` |
| `health` | `{ state: HealthState, checkedAt }` | Independent of `state`: a resource can be `ready` and `unhealthy` |
| `permissions` | string[] | Capability IDs this project may use on the resource |
| `sharing` | `project` \| `shared_selected` \| `pool_lease` | `pool_lease` is used for desktops |
| `lease` | `{ held, runId, expiresAt }` or null | Desktop pool only; leased only on demand, never at project creation |
| `updatedAt`, `verifiedAt` | ISO time or null | |

### Enums

- `ProvisioningState`: `pending` | `provisioning` | `ready` | `needs_connection` | `needs_approval` | `failed`.
  - Optional plugin resources that are not enabled do **not** appear in the resource list. The Integration Hub shows them as not enabled.
- `BlockerCode`: `connection_missing` | `connection_unhealthy` | `approval_required` | `provider_unsupported_operation` | `quota_exceeded` | `permission_denied` | `local_service_unavailable` | `reconcile_conflict` | `unknown`.
- `HealthState`: `unknown` | `healthy` | `degraded` | `unhealthy`.

### PluginPackage

| Field | Values |
|---|---|
| `id`, `name`, `version` | string |
| `firstParty` | boolean |
| `state` | `installed` \| `disabled` \| `update_available` \| `failed` |
| `accountMultiplicity` | `single` \| `multiple` (one plugin, several accounts) |
| `authModes` | (`oauth` \| `pairing` \| `api_key` \| `managed`)[] |
| `isolation` | `first_party_in_process` \| `sandboxed` \| `host_privileged`; `host_privileged` must be shown as "not isolated" |
| `capabilities` | capability ID[] |

### Connection

| Field | Values |
|---|---|
| `id`, `pluginId`, `label` | `label` is a non-secret display name |
| `state` | `configured` \| `needs_auth` \| `revoked` |
| `health` | `{ state: HealthState, checkedAt }` |
| `scopes` | string[] |
| `hasCredential` | boolean (never the credential itself) |

### Capability

| Field | Values |
|---|---|
| `id` | e.g. `message.send`, `repository.create`, `issue.create`, `data.query`, `desktop.lease` |
| `pluginId` | string |
| `risk` | `read` \| `write` \| `external_effect` \| `spend` |
| `requiresApproval` | boolean |

### InstanceBinding (instance-level enablement)

| Field | Values |
|---|---|
| `pluginId` | string |
| `scope` | `global` \| `selected_projects` |
| `projectIds` | string[], for `selected_projects` |
| `connectionIds` | allowed connections |
| `capabilities` | the ceiling for projects |

### ProjectPluginBinding (effective, per project)

| Field | Values |
|---|---|
| `projectId`, `pluginId` | string |
| `enabled` | boolean |
| `source` | `inherited` \| `project` |
| `connectionId` | the selected allowed connection, or null |
| `effectiveCapabilities` | capability ID[] |
| `narrowedFrom` | `{ capabilities: string[] }` or null, the inherited set before narrowing |

## Semantics

- **Inheritance narrows only.** `effectiveCapabilities` is the intersection of the instance ceiling (`InstanceBinding.capabilities`), the provider scopes, the parent authorization and the project's own selection. A project can disable a plugin, pick among allowed connections, or remove capabilities. It can never add any. A client must not offer widening.
- **State and health are independent.** Render `blocker.message` and `blocker.remedy` exactly as given; never fabricate success.
- **Local baseline:** a new project is useful with `local_git`, plus `oxrm_workspace` once the bundled OXRM service is verified healthy. Otherwise that resource is `failed` or `needs_connection` with `local_service_unavailable`. `desktop_pool` is a capability with on-demand leases.
- **Optional external resources** (`github_repo`, `jira_project`, `whatsapp_conversation`, others) appear only when their plugin is enabled for the project. Automatic creation happens only under an explicitly enabled plugin and an existing grant.
- Execution truth stays in Orkestr task/run/effect/approval/event records. These DTOs never mark work complete.
