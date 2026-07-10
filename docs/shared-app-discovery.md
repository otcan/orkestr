# Shared App Discovery Plan

Orkestr shared apps should be discoverable by agents and users without knowing
the URL token, app slug, or backing instance details. The goal is to make a
request like "share the example XRM review tool" resolve to the correct shared
app, create a fresh approval challenge, and return a usable public URL.

## Current State

Shared apps are stored in the Orkestr shared-app registry:

- Apps define `instanceId`, `appSlug`, `title`, `description`, `appType`,
  `backingSystem`, and `backingInstanceId`.
- Shares define `viewKey`, `viewType`, `filtersJson`, `visibleFieldsJson`,
  `allowedActionsJson`, and token hash.
- The stable public URL is derived from:
  `/i/:instanceId/a/:appSlug/s/:shareToken`.
- Browser access is scoped through a per-share approval challenge.

This works once the app is known, but discovery is weak:

- Agents need to know the app slug or stable URL from local docs.
- There is no compact "list shared apps" endpoint for operational discovery.
- Intent aliases such as "example review", "contact classifier", or "to-skip
  tool" are not represented in the registry.
- Shares do not currently expose a safe token reference unless the caller
  already knows the token.

## Target Shape

Add a shared-app catalog layer above the existing app/share registry.

Each catalog item should expose:

```json
{
  "instanceId": "orkestr-ui",
  "appSlug": "example-outreach",
  "title": "Example Outreach Review",
  "description": "Review example contacts and classify them.",
  "appType": "people-message-labeling",
  "backingSystem": "xrm",
  "backingInstanceId": "example-xrm",
  "viewKey": "example-leads",
  "labels": ["not_evaluated", "to_contact", "to_skip"],
  "actions": ["setClassification", "setNote"],
  "intentAliases": [
    "example xrm review",
    "example outreach review",
    "example contact classifier",
    "to contact to skip",
    "outreach review"
  ],
  "primaryShareId": "share-e9dcan1NsOiIDA",
  "publicUrl": "https://orkestr.example.test/i/orkestr-ui/a/example-outreach/s/<token>"
}
```

The token should not be exposed in broad unauthenticated listings. Admin/agent
discovery can include either the full URL or a `createChallengeUrl` action.

## API Plan

Add admin-scoped catalog endpoints:

```text
GET  /api/shared-apps/catalog
GET  /api/shared-apps/catalog?backingInstanceId=example-xrm
GET  /api/shared-apps/catalog?intent=example%20review
POST /api/shared-apps/catalog/:appSlug/challenge
```

Expected behavior:

- `GET /catalog` returns all active shared apps with non-secret metadata.
- Filters support `instanceId`, `appSlug`, `backingSystem`,
  `backingInstanceId`, `viewKey`, and free-text `intent`.
- `POST /catalog/:appSlug/challenge` resolves the primary active share and
  creates a scoped browser approval challenge.
- If multiple shares exist, the API either selects the marked primary share or
  returns `multiple_matching_shares` with candidate share IDs.

Keep the existing low-level routes:

```text
GET  /api/shared-apps
GET  /api/instances/:instanceId/apps/:appSlug/shares
POST /api/shared-apps/i/:instanceId/a/:appSlug/s/:shareToken/challenge
```

Those remain exact-control routes. The catalog routes are for discovery.

## CLI Plan

Add CLI wrappers:

```bash
orkestr shared-apps list
orkestr shared-apps find "example review"
orkestr shared-apps challenge example-outreach
orkestr shared-apps challenge --backing-instance example-xrm --intent review
```

Useful output should be compact:

```text
Example Outreach Review
  app: orkestr-ui/example-outreach
  backing: xrm/example-xrm
  queue: example-leads
  labels: not_evaluated, to_contact, to_skip
  challenge: orkestr shared-apps challenge example-outreach
```

`challenge` should print:

```text
URL: https://orkestr.example.test/i/orkestr-ui/a/example-outreach/s/...
Approve: orkestr connect approve <code>
Expires: ...
```

## Registry Changes

Extend app metadata with optional discovery fields:

```json
{
  "intentAliasesJson": [
    "example xrm review",
    "example outreach review",
    "contact classifier"
  ],
  "primaryShareId": "share-e9dcan1NsOiIDA",
  "ownerInstanceId": "example-xrm",
  "documentationPath": "docs/shared-apps/example.md"
}
```

If schema churn is undesirable, store this under `metadataJson` first and split
it into columns later.

## Agent Behavior

When an agent in a thread receives:

```text
share the example XRM review tool
create the example contact classifier link
open the to-contact/to-skip review app
```

It should:

1. Query the shared-app catalog by current thread instance and text intent.
2. Prefer exact `backingInstanceId` matches, for example `example-xrm`.
3. Create a fresh challenge for the primary share.
4. Return the stable URL and approval command.
5. Avoid exporting local snapshots or queue files.

## Security Rules

- Catalog listing is admin/agent scoped.
- Public token URLs remain protected by per-browser approval challenges.
- Shared app sessions must stay scoped to the app slug, share ID, instance ID,
  and allowed actions.
- Review actions are limited to explicitly declared actions such as
  `setClassification` and `setNote`.
- Do not expose secret token hashes in catalog output.

## Rollout

1. Add metadata for existing shared apps:
   - `example-outreach`
   - `demo-outreach`
   - legacy native review apps if still useful
2. Add the `GET /api/shared-apps/catalog` endpoint.
3. Add catalog search scoring by title, description, app slug, backing instance,
   view key, and aliases.
4. Add the catalog challenge endpoint.
5. Add CLI commands.
6. Update thread docs to point agents at the catalog instead of hardcoded URLs.
7. Add regression tests:
   - list includes example app
   - intent `example review` resolves to `example-outreach`
   - challenge creation returns a scoped pending challenge
   - unpaired browser cannot access data
   - paired session can read, classify, and save notes only for the scoped share
