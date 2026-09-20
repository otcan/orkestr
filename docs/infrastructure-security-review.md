# Infrastructure security review and release preparation

These tools prepare changes from explicitly scoped metadata. They do not
authenticate to providers, retrieve Secrets, exec into workloads, install roles,
apply manifests, change DNS, restart services, or declare production recovered.
Keep snapshots and reports outside this public repository. Do not place secret
values in any input. Supplied review flags are operator assertions, not proof
that a live test was performed.

## Offline entry point

```sh
node scripts/security/review-infrastructure.mjs \
  --mode kubernetes --input /absolute/private/review.json
```

Inputs are bounded JSON snapshots. The command prints a minimized result and
returns 2 for an adverse assessment, 1 for invalid/incomplete input, 0 for a
generated proposal or passing assessment. A successful proposal is **not** live
acceptance. There is deliberately no apply mode.

| Mode | Input | Purpose and remaining gate |
| --- | --- | --- |
| `kubernetes` | `objects`, optional `policy.exceptions` | Workload token/default identity and RBAC lint; inventory completeness, custom resources and effective authorization still require review. |
| `automount-plan` | `object`, `review` | Version-fenced automount patch only after an owned no-API-need decision; rollout and token-free pod validation remain. |
| `aws-audit-plan` | explicit principal ARN, role, regions, owner, change reference, `authentication: iam_mfa` | Exact read-action proposal and permissions boundary; creation, actual-context simulation and owner approval remain. Federated trust needs a separate reviewed policy. |
| `credential-metadata` | access-key identifier, listed key metadata, last-use metadata, containment/observation times | Never authenticates with the disclosed key. Absence under a supplied principal is not deletion proof. Complete principal binding, activity review and store cleanup remain. |
| `dns-plan` | exact zone, alias inventory, obsolete targets and every candidate's owned disposition | Exact change/rollback records; no retired-target probing. Fresh authoritative comparison and approved window are mandatory. |
| `registrar` | exact expected domains and fresh metadata | Lock/renewal/MFA/recovery/payment/alerts evidence checklist; no account or payment data is returned. Provider verification remains. |
| `transport` | exact `policy`, `protocol`, `response` | Offline redirect/HSTS assessment only. TLS and callback acceptance require actual observations. |
| `transport-plan` | namespace, name, approved HSTS age, `compatibilityReviewed` | Middleware candidates only; does not attach to routes. ACME, callbacks and rollback need qualification. |
| `canonical-routing` | adapted Caddy `config`, exact `bindings` | Checks GET and POST upstream resolution for canonical API paths; unsupported matchers/groups/handlers fail to manual review. Live identity/auth-boundary and all-listener checks remain. |

The Kubernetes exception format is an exact kind/namespace/name/rule plus owner,
reason and expiry (maximum 90 days). Missing role/account inventories are not
waivable. An automount patch must not be used for workloads with explicit
projected service-account tokens or an unknown Kubernetes API dependency.

`probeTransportPolicy` is an exported, separate opt-in function for an approved
host/path list: bounded HEAD only, no redirects followed, no GET fallback, no
body collection, and separate TLS 1.2/1.3 handshakes. The CLI never invokes it.
Transport plans intentionally do not enable preload or includeSubDomains.

Registry planning is documented in [registry-hardening-plan.md](registry-hardening-plan.md).
Systemd/resource/evidence activation is separate from this tooling; see
[sre-policy-and-qualification.md](sre-policy-and-qualification.md).

## Redacted secret scanning

CI downloads Gitleaks 8.30.1 from its official release and verifies the pinned
archive SHA-256 before execution. The wrapper verifies the version, forces its
reviewed default-rules config, ignores repository-local suppressions, discards
scanner output and minimizes the redacted JSON. Reports contain only repository,
commit, path, detector, line, triage status and a per-report salted **location**
fingerprint; this is not a credential-value fingerprint.

Merge-result diffs are included, and external diff/textconv execution is disabled.
The separate reviewed-finding policy can classify only exact immutable
commit/path/detector/line locations, with reviewer, ticket and expiry. Findings
remain visible in reports with separate reviewed/unresolved counts. No wildcard
or test-directory suppression is supported. The initial two dispositions are
self-authored local reviewer-session HMAC fixtures, independently confirmed by
their author as never issued or used externally. They are not provider secrets.
The same fixtures in the original worker commit are separately bound. Ten
historical LinkedIn-detector locations were reviewed as field-name arrays or a
variable/empty-string conditional, including identical lines repeated in merge
commits. Exact locations are classified as nonsecret syntax, never whole paths.

```sh
node scripts/security/secret-scan.mjs \
  --binary /absolute/verified/gitleaks \
  --repository /absolute/checkout --label example/repository \
  --report /absolute/private/new-report.json
```

Default scope is all locally available Git refs, not inaccessible repositories,
unfetched provider refs or external artifacts. `--base <full-commit-id>` scans
that commit to HEAD. CI uses the PR base/push previous SHA; manual dispatch scans
all checked-out refs. The report is private mode 0600, outside the checkout,
created exclusively and never uploaded as a public CI artifact. Exit 2 means
findings requiring private triage; scanner failures never count as clean.

Do not print matches, test a detected credential, rewrite history, add a blanket
baseline ignore, or close provider alerts based only on a clean range scan.
Branch-protection enforcement is an administrative follow-up, not something
this workflow silently configures. Repository-private coverage and independent
revocation evidence remain explicit acceptance gates.

## Review references

- [Kubernetes service-account token precedence](https://kubernetes.io/docs/tasks/configure-pod-container/configure-service-account/)
- [Kubernetes RBAC security guidance](https://kubernetes.io/docs/concepts/security/rbac-good-practices/)
- [AWS NotAction semantics](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_elements_notaction.html)
- [AWS authentication condition keys](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_condition-keys.html)
- [Traefik middleware routing](https://doc.traefik.io/traefik/reference/routing-configuration/kubernetes/crd/http/ingressroute/)
- [Gitleaks scanner](https://github.com/gitleaks/gitleaks)
