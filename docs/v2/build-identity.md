# Development artifact identity

The next paired artifact uses `2.0.0-dev`. An RC label is a separate release
transition; creating a receipt does not qualify or publish an RC. The coordinator
owns the workspace version and lockfile change. Previously retained packages and
receipts keep their historical metadata and evidence limitations.

The build owner supplies `ORKESTR_V2_BUILD_IDENTITY` separately for each build:

```text
ORKESTR_V2_BUILD_IDENTITY_V1|server|2.0.0-dev|<exact-clean-40-character-source>|END
ORKESTR_V2_BUILD_IDENTITY_V1|web|2.0.0-dev|<exact-clean-40-character-source>|END
```

These records must be retained in the server ELF and compiled web WASM. The
version must equal `CARGO_PKG_VERSION`; the source is the exact clean checkout,
never a guessed successor or a commit invented before committing. `build_pair.py`
checks the clean checkout and workspace version, supplies the records and seals
only the matching artifacts. No timestamp or private host path is included.
Unpinned ordinary developer builds report an unknown source and cannot be sealed.

The registered server module `build_identity` exposes `identity()` through
`GET /api/v2/health` in the `build` field and `version_output(args)` for the entry
point. Native argument handling precedes even the async runtime, as well as
reading HOME, bootstrap, configuration or state:
`--version`, `-V` and `--version --json` return immediately; unsupported arguments
refuse startup. The existing health fields remain unchanged. Retaining and
displaying the matching web identity is a separate UI integration step; a native
identity alone is not a verified native/web pair.

Paired receipt format v2 verifies the embedded server and web records without
executing either artifact. It rejects unknown, missing, malformed, conflicting,
wrong-component, wrong-version and wrong-source records, including attempts to
relabel a development artifact as an RC. Native and Docker candidate assembly
share this verifier and propagate the verified version/source into their
manifests. Old v1 receipts are intentionally not promoted to verified embedded
identity: only the upgrade adapter opts into historical integrity verification for its
explicitly pinned predecessor. Successors, assembly, native acceptance and daily
use still require v2. No receipt is rewritten or promoted.

This is deterministic identity and integrity checking, not a signed build
attestation: a trusted producer can insert arbitrary bytes. The clean source,
tool pins, exact inventories and independent review remain necessary. Python
synthetic tests neither compile Rust/WASM nor qualify health/About or actual
`--version` behavior. The native executable tests check an absent HOME, an absent
V2 home and an existing home whose bytes remain unchanged; unsupported arguments
also cannot create state. An ordinary disabled-server HTTP test compares its
health identity to the same executable's CLI result. Exact pinned build evidence
and the matching WASM remain necessary before package/native/Docker acceptance.
