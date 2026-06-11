# OSS And Managed Boundary

The OSS repo is the public product surface. It should stay installable, readable,
and useful without private operator state.

The managed/private deployment is allowed to add production accounts, private
host routing, operator dashboards, private overlays, and deployment-specific
automation. Those pieces must not be required for the OSS install path.

## OSS Repo

The OSS repo owns the self-hosted Codex control center:

- local and VPS install paths
- Codex app-server setup and persistent threads
- browser and phone web control
- status, approval, interruption, and local history
- optional WhatsApp routing and timers
- generic browser desktop support
- the secure-input secret manager contract
- public demos, smoke tests, and launch checks

The OSS path must boot from public code with fake or user-provided settings. It
must not depend on real WhatsApp identities, private hostnames, managed tenant
accounts, private browser profiles, or operator-only deployment files.

## Managed/Private Repo Or Overlay

Managed/private code owns production deployment concerns:

- real production domains and host-specific routing
- operator-only broker views and aggregated admin data
- private connector account bindings
- production WhatsApp sender/responder identities
- tenant provisioning policies that expose operator infrastructure details
- private release notifications and deployment automation
- private overlay files loaded through `ORKESTR_OVERLAY_DIR`

Managed code can depend on the OSS package and extend it. OSS code should not
import managed-only modules or require managed-only environment variables.

## Deployment Split

The production deployment should have two tracks:

- **Managed track:** private operator deployment with real accounts, private
  overlays, production routing, and private release state.
- **OSS track:** public-repo deployment proving that a clean checkout can
  install, boot, pass health checks, and run the simplified Codex workflow.

Both tracks need separate release manifests, health checks, rollback paths, and
version reporting. The OSS track is the public proof that Orkestr is not only a
private workstation.

Every running instance should expose its distribution identity through
`/api/version`:

- `distribution.kind`: `oss` or `managed`
- `distribution.track`: deployment track such as `oss`, `managed-production`, or
  `managed-stage`
- `distribution.repoRole`: whether the release was built from the public OSS repo
  or managed/private repo

Set these with `ORKESTR_DISTRIBUTION`, `ORKESTR_DEPLOYMENT_TRACK`, and
`ORKESTR_REPO_ROLE`, or pass `--distribution`, `--track`, and `--repo-role` to
`scripts/release-manifest.mjs`.

Use `npm run deploy:split-plan` to generate a dry-run managed/OSS deployment
profile with separate roots, service names, ports, repo URLs, release manifests,
and `/api/version` verification expectations.

## Boundary Rules

- Keep credentials, tokens, browser profile state, real chat IDs, and private
  hostnames outside the repo.
- Read secrets through the secret manager or existing protected secret stores,
  not ad hoc public config files.
- Add new managed-only features behind a clear boundary before surfacing them in
  public docs or demos.
- Public docs should lead with the simplified OSS flow before mentioning
  optional or managed/private features.
- `npm run oss:boundary-check` must pass before release.
