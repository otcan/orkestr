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

The server leaf `build_identity` exposes `identity()` for read-safe health/About
metadata and `version_output(args)` for the entry point. The entry point must
handle this result before reading HOME, bootstrap, configuration or state:
`--version`, `-V` and `--version --json` return immediately; unsupported arguments
refuse startup. Registering this leaf, exposing health metadata, and retaining
and displaying the matching web identity are coordinated server/UI integration
steps. Rust registration/build/CLI side-effect acceptance is pending until those
steps and an exact successor artifact are available.

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
`--version` behavior. An integrated successor must demonstrate those checks with
an absent HOME and a fresh configured home, byte-identical before and after the
version query, before package/native/Docker acceptance can be credited.
