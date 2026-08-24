# LinkedIn Outreach Scope

The LinkedIn MCP runtime fails closed unless each routed plan matches one
explicit Orkestr binding. A binding joins these identities:

- Orkestr `threadId`
- managed LinkedIn `desktopSlug`
- oXRM `outreachWorkspaceId`
- `linkedinAccountAlias`
- safe `oxrmEndpointId`
- exact private `oxrmEndpoint`

Keep real bindings in a private overlay. Point the runtime at that file with
`ORKESTR_LINKEDIN_OUTREACH_BINDINGS_FILE` or `--bindings`. Do not commit the
file. A public-safe example is:

```json
[
  {
    "bindingId": "binding-example-a",
    "threadId": "thread-example-a",
    "desktopSlug": "linkedin-example-a",
    "outreachWorkspaceId": "workspace-example-a",
    "linkedinAccountAlias": "account-example-a",
    "oxrmEndpointId": "oxrm-example-a",
    "oxrmEndpoint": "https://oxrm-a.example.invalid/mcp"
  },
  {
    "bindingId": "binding-example-b",
    "threadId": "thread-example-b",
    "desktopSlug": "linkedin-example-b",
    "outreachWorkspaceId": "workspace-example-b",
    "linkedinAccountAlias": "account-example-b",
    "oxrmEndpointId": "oxrm-example-b",
    "oxrmEndpoint": "https://oxrm-b.example.invalid/mcp"
  }
]
```

The endpoint must be an HTTP(S) URL without credentials, query parameters, or
a fragment. Binding IDs, route identities, workspace IDs, account aliases, and
endpoint IDs must be non-empty public-safe identifiers. A thread may have only
one binding. Reusing an account, desktop, endpoint identity, or endpoint for an
inconsistent scope makes the whole registry invalid.

## Plan Contract

A plan selects its binding explicitly. Campaign names, contact fields, source
lists, and LinkedIn profile URLs are never consulted for ownership.

```json
{
  "contractVersion": "linkedin.mcp.v1",
  "threadId": "thread-example-a",
  "desktopSlug": "linkedin-example-a",
  "bindingId": "binding-example-a",
  "outreachWorkspaceId": "workspace-example-a",
  "linkedinAccountAlias": "account-example-a",
  "calls": [
    {
      "tool": "linkedin.select_candidates",
      "stage": "selector",
      "input": {}
    }
  ]
}
```

Before acquiring a desktop lease, Orkestr resolves the exact binding and adds
an immutable, endpoint-sensitive fingerprint to the plan and every call. The
same scope is used for selector, claim, intake, outcome-writer, detached-worker,
recovery, and requeue transitions. A persisted fingerprint that no longer
matches the private registry is stale and cannot run.

The runtime gives the LinkedIn module the exact endpoint internally. Runtime
status and audit events expose only `bindingId`, `bindingFingerprint`,
`threadId`, `desktopSlug`, `outreachWorkspaceId`, `linkedinAccountAlias`, and
`oxrmEndpointId`. They never expose the endpoint URL.

## oXRM Boundary

Orkestr validates routing and injects the scope pair into every MCP call, but it
cannot prove that the separate oXRM deployment filters its database correctly.
The remaining cross-repository contract is tracked in
[otcan/oxrm#68](https://github.com/otcan/oxrm/issues/68): oXRM must bind each
deployment to the same pair, reject missing or foreign API/MCP scopes, filter
selection and send counters by both values, reject mismatched writes, and block
unscoped legacy rows until they are explicitly reviewed and backfilled.

Generic non-LinkedIn oXRM and non-LinkedIn Orkestr workspaces do not use this
runtime contract and remain unchanged.
