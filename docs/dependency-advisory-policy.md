# Continuous dependency advisory coverage

ORK-511 / SCM-002 covers the exact npm v3 lockfile, including development,
optional, platform-specific and transitive packages. This is advisory detection,
not proof that a package is non-malicious. No application dependency versions
are changed by this control, and it never invokes `npm audit fix`.

## Scanner and evidence

The zero-dependency Node scanner is versioned in `scripts/security/`. It uses
only the [OSV v1 API](https://google.github.io/osv.dev/post-v1-querybatch/),
querying exact public npm names/versions in batches and fetching advisory details
by ID. Pagination is exhaustive or fails closed. Network errors, unexpected
response shapes, unknown severity, missing coverage, invalid lockfiles and
unwritable evidence are not clean scans. Per-request and total deadlines bound
service outages. No credentials, private registry configuration, raw responses,
advisory prose, package scripts or environment values are published.

Each finding contains only package, version, advisory ID, severity, status and
fixed version(s). Fixed versions are advisory-provided candidates, not an
automatic upgrade recommendation. Aggregate evidence contains exact candidate
and trusted-policy commits, lock/policy SHA-256, timestamps and counts. The
scanner checks Git identities and rejects dirty policy or changed input files.
GitHub artifact publication is mandatory, with 14-day retention; failed or
missing upload ID/digest makes the `dependency-policy` aggregate check fail.

Run from a committed clean checkout (report file must not already exist):

```sh
npm run security:dependencies -- --root "$PWD" \
  --commit "$(git rev-parse HEAD)" --policy-commit "$(git rev-parse HEAD)" \
  --report /absolute/private/path/dependency-evidence.json
```

PR and merge-queue scans execute scanner/policy from the immutable base commit,
not the candidate. Push/manual/scheduled checks execute the accepted commit.
New action references are full upstream commit SHAs with release annotations;
the remaining existing CI actions are tracked by ORK-507. All new checkouts
disable credential persistence; workflow permissions are read-only.

## Blocking and triage policy

- Critical/high and unknown-severity open findings block builds and landing.
- Moderate/low findings remain visible in evidence. Repository security owner
  (maintainers, accountable release owner) triages critical within 24 hours,
  high within two business days, moderate within seven days, low within 30 days.
- Critical findings require immediate mitigation/release assessment; high fixes
  target seven days, moderate 30 days, low the next reviewed update cycle.
- Exceptions require the owner/reviewer, issue reference, exact package/version/
  advisory and explicit approval/expiry dates. Maximum seven calendar days;
  no wildcards, indefinite grants or automatic extension. Expired/invalid
  entries fail the entire gate. Critical exceptions should be limited to
  24 hours and require explicit risk acceptance. Initial exception set is empty.
- Scan on every PR, merge group, main push, manual run and daily at 05:17 UTC.
  Maintainers monitor failed scheduled runs and GitHub security notifications;
  a missed daily run or unavailable analysis for 24 hours requires investigation.
  Review dependency and action updates weekly through the normal release train.

This is a proposed policy until owner review lands it and ORK-478 enforcement is
activated. Repository JSON alone cannot establish an authentic human approval.

## Provenance and lifecycle controls

Every locked package must have an exact version, SHA-512 integrity and the
canonical HTTPS npm registry tarball URL. Local/git/foreign-registry/bundled/link
sources, query strings and ambiguous integrity are refused. These checks do
not replace npm's tarball integrity verification.

The six currently script-bearing packages are bound to exact version, integrity
and lifecycle-script digest in `dependency-policy.json`, with a rationale for
each: `@parcel/watcher`, `esbuild`, `fsevents`, `lmdb`, `msgpackr-extract`, and
`puppeteer`. None needs lifecycle execution on the supported Linux CI runner:
locked optional prebuilds, JavaScript fallbacks and managed runtime browsers
cover the requirement. Review updates to these entries explicitly; a version,
tarball or script change is not auto-approved because the package name matches.

Before installation, the advisory job validates lockfile lifecycle declarations
against trusted policy. All three CI install locations use
`npm ci --ignore-scripts --no-audit`. After extraction, the trusted inventory
checker reads installed package manifests without importing package code and
detects hidden lifecycle scripts and implicit `binding.gyp` builds, before any
build/test command. This second check addresses missing/forged lockfile flags.
Optional packages absent on the runner are still included in the advisory scan.

The only separately invoked local patch is the repository-owned
`patch-whatsapp-media-id.mjs`; its contents and root postinstall command are
hash-reviewed before invocation. No dependency `npm rebuild` or lifecycle
script fallback is permitted. If a future platform needs one, revise the policy
through review rather than silently enabling scripts for all packages.

## ORK-478 landing-gate activation

`.github/dependency-required-checks.json` is an integration contract, NOT proof
of branch protection. ORK-478 owns live ruleset design and approval. Require
`dependency-policy` and `secret-policy` (GitHub Actions producer) alongside
`secret-scan`, preserving
all other existing checks. Require up-to-date branches, owner review of
workflow/scanner/exception/CODEOWNERS changes, and no silent admin bypass.
Protect package manifests, lockfile and npm configuration as well: they select
the parser and the workflow-check command. `secret-policy` additionally requires
successful aggregate-evidence publication; `secret-scan` alone is not the
complete ORK-508 landing contract.
A normal required status check alone cannot prevent a writer modifying its
own workflow to forge success; protect workflow/policy review or use a separately
managed required workflow under the reviewed ORK-478 design.

Bootstrap deliberately fails on a PR whose base lacks this scanner. There is
no fallback to executing candidate policy. The release owner must review and
qualify the initial scanner commit locally, then approve its initial landing
under ORK-478; run authorized CI at that immutable commit before enforcing the
new check. Subsequent policy/dependency updates must be staged so the trusted
base contains approved lifecycle/exception changes before dependent changes.
Do not disable existing secret checks to bootstrap this one.

Before closure, read back active rulesets and qualify a denied landing for a
failed, skipped, missing or unpublished scan. Retain exact accepted SHA, package
and advisory counts, Dependabot/graph control state and rule-enforcement evidence.
Local tests and the proposed config do not satisfy this external enforcement
acceptance criterion. CI dispatch, main merge and enforcement activation remain
separate owner-reviewed release steps.

## GitHub controls and rollback

Enable/read back Dependabot alerts using the repository vulnerability-alerts
API; that operation also enables the dependency graph. Verify the alerts and
dependency-graph SBOM APIs separately; initial SBOM population can lag. See
[GitHub's API contract](https://docs.github.com/en/rest/repos/repos#enable-vulnerability-alerts).
Automated security-update PRs remain a separate owner decision; they are not
required for alert/scanner coverage and must not bypass release review.

Rollback is a reviewed revert of this CI/configuration change, coordinated with
ORK-478 required checks so missing checks cannot silently permit landing. Do not
disable repository alerts, weaken provenance, delete evidence, change application
dependencies, or enable broad lifecycle execution as a rollback shortcut.
