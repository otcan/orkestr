# Reviewed broker inventory fingerprint

The pinned secret scanner matches the `api` substring in `reaping.py` and treats
its source fingerprint as a generic credential. Independent inspection confirmed
that the reported value equals the SHA256 of the tracked lifetime module.

The trusted scanner configuration now permits only that exact fingerprint on a
whole `reaping.py` inventory-entry line in either of these exact paths:

- `v2/provider-broker/codex-package.json`
- `v2/provider-broker/claude-package.json`

The path and line conditions are combined with AND and apply only to the
`generic-api-key` rule. A changed fingerprint needs a fresh review. Other fields,
adjacent credentials, other paths, arbitrary hashes and provider-specific rules
retain default detection. History scanning and merge-diff scanning stay enabled.

The actual pinned scanner regressions reproduce the original two matches before
applying the exception. They also require generated credential-shaped fixtures
inside and outside both manifests, a provider-specific fixture, altered paths,
other hashes and altered entry contexts to remain detectable. The CI secret-scan
job runs these checks using its already downloaded, checksum-verified scanner.

Pull requests still use the base commit's policy for the repository scan. A PR
cannot approve its own exception; this reviewed policy must reach the trusted
base before the affected feature history can pass.
