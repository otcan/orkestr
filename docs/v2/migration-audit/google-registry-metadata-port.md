# Mutation-free Google registry metadata port

`v2/migration/google_registry_metadata.py` is an executable, isolated read port for
the existing nonsecret registry format. It opens only
`google-workspace-connections.json`, never initializes a store and never invokes
connector code. It is not a registered HTTP route or a replacement authentication
system. No dependency, shared auth, manifest, schema or route changed.

## Exact embedding API

```python
read_registry_metadata(
    RegistryDescriptor(owner=owner_id, path=server_selected_registry_path),
    current_owner=request_bound_current_account_check,
)
```

`current_owner()` must perform the embedding service's **current** authenticated
owner check on each invocation and return `CurrentAccount(user_id, kind,
machine, anonymous)`. It is invoked before any file open and again immediately
before delivery. The leaf requires exact `kind="user"`, `machine=False`,
`anonymous=False` and equality of the account ID with the descriptor owner.
Missing, foreign, machine, host-operator and anonymous accounts refuse. An admin
role never implies another account's registry. These objects must be built by
the server adapter, not deserialized from a client body or supplied by a model.
A data class is not an authentication capability on its own.

The descriptor is selected by the trusted server's owner-to-registry mapping.
A URL/query/body must not provide an owner ID, path or principal. The adapter
must not call legacy `connectorScopePaths`, which creates directories, nor
`listGoogleWorkspaceConnections`, which may migrate credentials. It must not
fall back from an unrecognized account to a global registry. Existing legacy
global registries require an explicit verified owner mapping, not an admin-role
inference. Other user registries must remain distinct.

**Missing integration ABI, for coordinator agreement:** a request-bound current
ordinary-account projection, plus a server-owned existing-registry descriptor
resolver for that exact account, with no initializer or credential lookup. The
adapter must recheck revoked/expired/logout sessions on both calls. The existing
V2 current-owner auth may implement this boundary, but this patch claims no
Python-to-Rust credential transport or registered Store API. Core is not asked
to allocate schema. Coordinator owns choosing/mounting the adapter; no permissive
temporary auth glue is provided. A later HTTP mapping must separately assign
401/403/unavailable responses and no-store headers without exposing paths.

## Source semantics and conservative refusal

The format is grounded in
`packages/connectors/src/google-workspace-connections.js::normalizeRegistry`,
`normalizeConnection`, `registryPath`, and
`google-workspace-scopes.js::capabilityDefinitions`.

The port requires schema version 1, an explicit matching registry owner and
explicit matching owners on **every** connection. Missing legacy ownership is
an unresolved migration case, never inferred authorization. It validates unique
normalized `connectionId` (or the source-defined `accountId` fallback). It does
not emit account IDs, aliases, email addresses, scope strings, token references,
thread defaults, errors, timestamps or filenames. Token-reference values in the
nonsecret descriptor are neither resolved nor returned; no token file is opened.

Output is a fixed dictionary: format version, connection count, separate counts
for `gmail_read`, `gmail_send`, `gmail_actions`, `gmail_drafts`, `calendar_read`,
`calendar_actions`, unknown-capability connection count, fixed health buckets,
fixed raw use-mode buckets, and three fixed evidence flags. Capabilities are
trimmed and deduplicated as in the source; unknown/case-mismatched values never
become ready or output keys. Other known capabilities, such as Drive, fall outside
this port's coverage and enter its unknown/out-of-scope bucket. Health/use-mode
values are raw metadata, with no implicit connected/default fallback.

No provider readiness, granted permission, fresh token or actual activity is
established. Empty owned configuration is not non-use. `explicit_only` remains
visible as its own bucket; metadata does not enable a connection.

## File cut, limits and tests

All directory components and the file are opened read-only with no symlink
following. Files must be regular and singly linked. Bounds are 1 MiB, 1,024
connections and 128 capability entries per connection. Oversize registries refuse
without truncation. Duplicate JSON keys, nonfinite/malformed JSON, missing files,
foreign or missing ownership, unsupported versions and duplicate identities
refuse. File identity/size/mtime/ctime are checked across the bounded read. An
opened coherent old inode is a file snapshot, not proof it is the latest registry
mapping or a cross-store cut. No file is created, repaired, rewritten or deleted.

The independent fake-registry test module exercises real temporary files and
intercepts open flags/write primitives: separate Gmail/calendar accounts,
metadata redaction, zero token lookup and writes, denied scope before open,
revocation before delivery, missing files, symlink ancestors, duplicate keys,
bounds, unknown states, mutation during read and empty configuration. It does
not invoke a provider, auth server, production registry or credential file.

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest \
  v2.migration.tests.test_google_registry_metadata \
  v2.migration.tests.test_optional_authority_inventory
```

Remaining acceptance belongs to the coordinator's adapter: real current-owner
session refusal after logout/revoke, two independent owner descriptors without
global fallback, and mounted route authorization. These checks are unexecuted;
passing the fake-registry tests does not qualify a mounted endpoint.
