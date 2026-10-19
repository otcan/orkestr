# Timer HTTP synthetic build evidence

Fixed source: `5b7762d35478ea02434176db867d215082e3d1a8`.
Immutable regression: `7445e04521552995f16af658d9c88b1239d4d2d2`.
Adapter/browser tests: `07efb6188c72f6c4a65376c82e100ec7ceef1b68`.

Disposable composition uses exact Core
`e62129f92c282862ace1b04e322f5e1d44bb6ee1`, owned timer HTTP/detail/input
files, temporary `pub mod timer_http;`, and only the existing browser credential
helper edge from `5f2ed3966b7c4587162e190dec0dc72865825fca`.
Manifests and lockfiles compare byte-for-byte with Core. No common router or
lifecycle registration is included; Deep owns that integration.

The unchanged regression failed both tests against the original controller
(expiry renewed; expired retry rearmed). Corrected composition: **4/4 PASS**,
including unchanged expiry, expiry/restart refusal and fresh disable/enable
positive control. Synthetic loopback tests cover Cookie/CSRF/Origin and mixed
auth refusal, revoked credentials, strict DTOs, due ordinary input and disabling
into held state. This is temporary loopback composition, not registered product
HTTP/browser qualification.

Executed through required `v2-cargo`, isolated home/target, offline and locked:

```sh
v2-cargo test --manifest-path "$COMPOSITION/v2/Cargo.toml" --offline --locked \
  -p orkestr-v2-server timer_http -- --test-threads=1
v2-cargo clippy --manifest-path "$COMPOSITION/v2/Cargo.toml" --offline --locked \
  -p orkestr-v2-server --all-targets -- -D warnings
```

Strict Clippy, owned Rust format check and `git diff --check`: PASS.
Test binary SHA256:
`81fa89bf8affc071e14ed591d3229fc45827bfc7ec452f0e54f3caa5f4fbd9fb`.
Private evidence retains per-file source hashes and terminal counts.

Exact retry reads its prior outcome without renewing or recreating local
execution authority. UI must describe rearming as canonical disable with current
revision followed by fresh explicit enable key. Unattended daily/weekly timers
and restart continuity remain blocking full-release requirements; durable
schedule authority must avoid persisted bearer credentials. No live timer,
provider, credential or production store was accessed or activated.
