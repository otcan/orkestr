# Public and Private Repository Boundary

The `otcan/orkestr` MIT repository remains public. Making it private would not
recall existing clones or forks and is not a substitute for a real data and
delivery boundary.

## Public OSS core

The public repository may contain generic product code, generic connector
contracts, self-host deployment scaffolding, public documentation, tests, fake
IDs and hosts, synthetic demo data, and assets created for public distribution.

Public examples must be reproducible without a customer account and must state
when connector or workflow behavior is deployment-specific.

## Private managed-delivery material

The following must stay in a private overlay or private operations repository:

- customer and tenant configuration;
- credentials, tokens, certificates, keys, OAuth state, and recovery material;
- WhatsApp or browser session state and real browser profiles;
- real hosts, phone numbers, email addresses, IDs, account mappings, and routes;
- customer-specific adapters and licensed integration code;
- infrastructure definitions that expose a real environment;
- private prompts, operational IP, internal runbooks, incident records, and
  release evidence;
- customer documents, records, screenshots, logs, analytics, submissions, and
  workflow output.

`ORKESTR_OVERLAY_DIR` is the code-level boundary for private deployment
configuration. Secrets also belong in the deployment's protected secret store,
never in either repository.

## Review checklist

Before public review or commit, verify that every new fixture uses synthetic
people, domains such as `example.test`, fake IDs, and non-sensitive workflow
content. Run `npm run oss:boundary-check` and inspect the staged diff for private
hostnames, contacts, tokens, customer names, and machine-specific home paths.

Commercial differentiation comes from workflow mapping, implementation,
private configuration, deployment hardening, safe release, monitoring, and
support. Revisit repository visibility only through a separate, explicit
decision that accounts for the permanent public history.
