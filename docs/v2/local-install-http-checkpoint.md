# Isolated Linux installation HTTP checkpoint

Executed against an admitted prebuilt Rust server and generated Rust web bundle.
This is a mixed-revision installation/HTTP checkpoint, not current candidate
browser, execution, or full-release acceptance. No compilation, download, Docker,
production home, credentials, or provider calls were used.

The assigned binary SHA-256 was verified before copying. Server source was
reported as `c8358b7fdd6fadbd3853a9067157f4c3876d394e`; UI source was reported as
`e9ea830e61614b792e77c8df01d968818530f567`. These are supplied build provenance,
not independently reproduced builds. Exact hashes/check results are in
[`real-package-checkpoint.json`](../../v2/local-install/tests/real-package-checkpoint.json).
The UI inventory digest hashes compact sorted JSON of relative-path/SHA-256
pairs. All ten files, including the 1,447,668-byte WASM, matched HTTP bytes.

Executed command shape (operational paths intentionally omitted):

```sh
python3 -B v2/local-install/tests/real_package.py \
  --binary "$assigned_binary" --expected-binary-sha256 "$assigned_sha256" \
  --ui-dist "$assigned_ui_dist" --source-commit "$server_commit" \
  --ui-source-commit "$ui_commit" --parent "$fresh_private_parent" \
  --port "$assigned_unused_loopback_port"
python3 -B -m unittest discover -s v2/local-install/tests -v
```

The opt-in probe copies artifacts, installs a fresh private home, checks version,
offline/running doctor and health, exercises synthetic setup/session/message
admission/idempotency/history, refuses running backup/upgrade, stops its owned
child, validates a stopped SQLite API snapshot containing one message, restarts
and checks history/receipt persistence, then switches to a new package version
label containing the **same binary**, restarts, and verifies history again.
That switch does not demonstrate cross-version schema compatibility. The probe
waits for owned supervisor exit, checks the port is reusable, and removes its
synthetic directory on success; failures retain private diagnostics. The caller
owns the fresh private parent and removes it only after success.

The first real run exposed a port probe rejecting TIME_WAIT after a successful
stop. SO_REUSEADDR fixes restart probing without SO_REUSEPORT or killing an
occupant. Mock regression checks both socket configuration and busy refusal.
Snapshot validation now rejects a manifest symlink before reading it; its
synthetic regression passes. Final result: 31/31 lightweight tests and the full
real HTTP probe passed; no owned child or synthetic installation remains.

Unexecuted gates: macOS, Docker, browser interaction/bootstrap handoff, live
providers, remote CI, cross-version schemas, mount/inode alias isolation, and
restore apply. Restore apply requires reviewed schema/instance binding and
dormant-work/auth policy; user permission is not the missing dependency.
