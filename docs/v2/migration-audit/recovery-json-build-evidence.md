# Executed recovery JSON adapter evidence

Exact source: `71d33688a92004462d95dcd6245d38257cd61f42`, correcting
`ee4e3e570bdf070146f549ef6bfad8271f86ecec`. Base:
`402ac1ad5ab712c353aa17e8d6f3a1fe6ffd61bc`.
Only the admitted recovery_export module insertion, recovery_json module and
synthetic wire fixture were applied to a disposable archive. Core changed the
leading recovery_export documentation, so the identical three-line insertion
was applied after `use super::*;` while preserving Core documentation.
Core mod.rs and all four recovery commit hooks remain unchanged.

The initial adapter failed compilation because Store lacked direct serde.
The corrected implementation uses existing serde_json with explicit field
allowlists and exact Python-compatible canonical ASCII re-encoding. Duplicate
keys cannot round-trip; unknown fields, changed fingerprints and noncanonical
encodings refuse. No manifest change is needed by the corrected decoder.

Two complete corrected-source checks executed:

| Input | Selected history tests | Strict feature all-target lint |
|---|---|---|
| Base + corrected adapter, original manifest/lock | 18 PASS, zero failures, exit 0 | PASS, exit 0 |
| Same + coordinator `0ccad8855d80a0d2da39e381277043fa1c1445b1` two-line Serde edge | 18 PASS, zero failures, exit 0 (1.93s) | PASS, exit 0 (8.88s) |

Both used the admitted wrapper, isolated home/target and:

```sh
v2-cargo test --manifest-path <archive>/v2/Cargo.toml --offline --locked \
  -p orkestr-v2-store-sqlite --features fixture-test-controls \
  history_import -- --test-threads=1
v2-cargo clippy --manifest-path <archive>/v2/Cargo.toml --offline --locked \
  -p orkestr-v2-store-sqlite --features fixture-test-controls \
  --all-targets -- -D warnings
```

The coordinator edge was accepted with locked resolution; no versions changed.
Before that edge, all eleven manifest/lock/toolchain files were verified unchanged.
After it, both specifically authorized changed files retained their input hashes.
Every other tracked archive file was compared with exact Core and remained equal.

SHA256:

| Artifact | Hash |
|---|---|
| Compiled recovery_export.rs (Core documentation preserved) | `8e8b90eba216716576f3cca0ad8aaa1fa0a9d26a3d6d60d95f960a50f4225169` |
| recovery_json.rs | `c3719585d5e9f99193c8c71f21d5cdbd97024ef220ae4fedefa3e706cdcb513f` |
| Synthetic recovery_wire_fixture.json | `5dea570436697d2426cac9d55fa44b007e9f065f80bf6c6bfe461b19e4547d34` |
| Unit executable, original dependency input | `62b39fea7a3e875e73f6ceca36224c532b2a30c00926e3800dca4537014179b4` |
| Unit executable, coordinator dependency edge | `6ff6bc642da4f6d870d4269f19992dba27515c35e855aa7d5fdae9b0e5684e42` |

Four new adapter tests cover Python-to-Core binary fingerprint compatibility,
Unicode/surrogate-pair/control encoding, unknown/duplicate/tampered refusal and
actual Store current authentication, restore, reopen and exact replay. Existing
fourteen selected history tests also pass; one is a child harness entry. Other
integration binaries compiled but their tests were filtered out, UNEXECUTED.
Rustfmt and diff checks PASS. Python suite previously executed 117/117 PASS.

Independent recovery four-window SIGKILL acceptance and live restore remain
UNEXECUTED by this lane. No production data was imported or execution activated.
