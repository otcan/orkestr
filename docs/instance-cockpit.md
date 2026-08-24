# Instance cockpit and configuration convergence

Orkestr has one durable user-facing namespace:

```text
/instance/{instanceRef}/
/instance/{instanceRef}/thread/{threadRef}
/instance/{instanceRef}/files
/instance/{instanceRef}/settings
```

The canonical app gateway remains the only instance router. It resolves opaque
public references through the instance registry, applies the existing instance
and thread authorization rules, and dispatches locally or through the broker.
The cockpit does not introduce another routing or tenancy layer.

## Desired and observed state

Each internal instance has a versioned, non-secret desired document at:

```text
<state-root>/instances/<safe-internal-id>/desired/instance.v1.json
```

The public instance reference is never used as a filesystem path. Writes use
generation compare-and-swap through `InstanceConfigService`; callers supply the
current generation through `If-Match` or the CLI `--generation` option. The
service records changed JSON pointers without recording values.

The desired document contains only these sections:

- `metadata`
- `runtime`
- `capabilities`
- `connectors`
- `desktops`
- `mailboxes`

Secret-bearing field names are rejected at every depth. OAuth state, tokens,
cookies, passwords, keyrings, private keys, QR state, and connector sessions
remain in their existing protected stores and are referenced only by opaque
connection identifiers.

Deployment-owned wiring is outside the desired document: Codex executable
commands, MCP transport configuration, and desktop host/profile paths are
rejected even when they contain no literal secret.

Observed state is written separately under `status/instance.v1.json`. A runtime
failure never rewrites desired state. `desiredGeneration` and
`observedGeneration` make drift explicit. The first implementation reconciles
the supported runtime-settings projection and reports stable
`reconciler_adapter_pending` conditions for sections that have not cut over.

Existing runtime settings are imported once, with deployment-only connector MCP
wiring and secret-bearing fields removed. Set
`ORKESTR_INSTANCE_CONFIG_AUTO_IMPORT=0` to hold an installation in pre-import
compatibility mode.

CLI and agent workflows use the same API:

```text
orkestr instance config get --json
orkestr instance config status --json
orkestr instance config patch --generation N --patch '{...}' --json
```

## Files

The cockpit file API exposes logical mounts and relative paths. It never returns
host paths. The current implementation:

- scopes mounts through the existing principal file-root policy;
- rejects traversal, symlinks, devices, FIFOs, sockets, and multiply linked
  regular files;
- hides and rejects environment files, private-key material, repository/auth
  metadata, and conventional credential directories;
- uses `O_NOFOLLOW` for file reads and writes where supported;
- bounds previews, downloads, upload count, and directory listings;
- supports browse, text preview, download, folder creation, and collision-safe
  upload;
- intentionally omits permanent recursive delete from the cockpit.

Secrets, OAuth stores, Gmail keyrings, WhatsApp sessions, browser profiles,
Codex authentication, raw environment files, host roots, `/proc`, `/sys`,
`/dev`, and `/run` are not mounts.

## Compatibility

Authenticated legacy GET routes redirect to the canonical instance cockpit when
the canonical gateway is enabled. Redirects preserve safe query strings and add
`Deprecation` plus a canonical `Link` header. Pairing, OAuth callbacks, and
provider-specific connector intent routes are not redirected.

Legacy mutation APIs remain during the migration window. New code must use the
instance service rather than adding another direct writer. Setup is shown only
for mandatory Codex readiness or an explicitly requested attended operation;
once ready, it resolves to instance settings. Mailboxes are absent unless the
desired document contains mailbox resources, and the cockpit view is read-only.

Rollback disables canonical routing or automatic import while preserving the
desired document. Before rolling back to a legacy binary after desired-state
writes have begun, freeze writes and materialize the last validated runtime
projection. Bidirectional synchronization between legacy state and desired state
is intentionally unsupported.
