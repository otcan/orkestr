# Web build identity

Settings includes an About view with package version, full source commit and the
verbatim embedded web record. The producer supplies:

```text
ORKESTR_V2_BUILD_IDENTITY_V1|web|<workspace-version>|<clean-full-source-sha>|END
```

`ORKESTR_V2_BUILD_IDENTITY` is read at compile time. The existing bundle script
inherits this environment into Cargo; no generated sidecar supplies the runtime
identity. Rendering the complete record keeps it referenced by the compiled web
application. The adapter validates component, package version and lowercase
40-character source. Missing source is explicitly unknown; malformed or
wrong-component records display an error and no source. The package verifier
must separately reject unpinned or mismatched artifacts.

Version comes from `CARGO_PKG_VERSION`, so integration uses the server owner's
coordinated `2.0.0-dev` workspace change without a second UI manifest/lock edit.
The UI branch's earlier workspace version is not relabeled by this source.
The native/server owner retains health.build registration. About describes only
the currently loaded web assets and does not claim matching server source or
release qualification. Packaging checks the server/web records together.

No bundle from an earlier accepted pair is rewritten. Exact release WASM record
retention and About rendering require the next matching clean source build and
its independent artifact/browser checks; parser/unit or compile checks alone do
not qualify that successor.
