# Paired beta artifacts

The existing paired-artifact and candidate packagers accept the explicit
`2.0.0-beta.1` version alongside `2.0.0-rc.N`, where `N` is a positive integer
without leading zeroes. Other beta versions, stable versions and build-metadata
suffixes are refused. Both receipt sealing and verification enforce this rule.
No package format changes: the exact version is retained in the paired receipt,
native manifest, Docker release metadata and candidate manifest.

Use the existing [candidate packaging workflow](release-candidate-packaging.md)
with `--version 2.0.0-beta.1`. The release coordinator must set the actual source
and artifact version before building; this change does not bump Cargo versions
or rewrite already-built artifacts. Existing clean-source, server/web integrity,
execution-control source binding, release-profile and default-feature checks
remain required. Hashes provide integrity, not signed build attestation.

This enables packaging only. It does not qualify runtime behavior, authorize
publication, start a provider or install an always-on service. A beta package
does not satisfy the full-release evidence gates.

Offline checks use a disposable local Git repository and synthetic, never-run
server/WASM files:

```sh
python3 -B -m unittest discover -s v2/packaging/candidate/tests -v
```
