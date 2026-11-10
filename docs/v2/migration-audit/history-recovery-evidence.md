# Isolated registered Store recovery evidence

Executed source: registered Core820fc2f0a2e1f4319237102ee1f9cf82544d57f9 plus
Migration2ba98823 history_import subtree in a disposable git archive. Only the
owned subtree was overlaid; eleven manifests/lock/toolchain files byte-match Core.
No live authority, source home, provider, external service or production data was
opened. All owner/namespace/conversation/message identities were synthetic.

Actual ordinary Store tests passed 9/9 (six original checks, two new scenarios
and the child helper's unarmed no-op). The abrupt-exit scenario separately starts
two children and requires exit86, without destructors or graceful pool closure.

- Stable per-conversation export pages produce the exact source digest/history
  request, imported under an independently created target owner.
- Reopen preserves the original import receipt and ordered message readback.
  Invalid current credentials/wrong owner and changed content refuse.
- A native target V2 message survives history rollback and is exported through
  the actual stable conversation-cut reader. Source history stays unchanged.
- A child exits with an unfinished real ledger transaction: reopen finds no batch.
  Another exits immediately after acknowledged import: reopen finds a complete
  active batch. Both reopen paths pass integrity_check and foreign_key_check.

The uncommitted branch deliberately exercises the transaction directly, not a
crash injected inside import_history. It therefore does not claim actual-method
SIGKILL, power-loss or all-instruction-boundary acceptance. Verification owns the
independent parent SIGKILL and complete inert-ledger oracle.

Commands executed through the existing capacity-limited wrapper and isolated
home/target (actual private paths and receipts remain outside OSS):

```sh
v2-cargo test --offline --locked -p orkestr-v2-store-sqlite history_import -- --test-threads=1
v2-cargo clippy --offline --locked -p orkestr-v2-store-sqlite --all-targets -- -D warnings
```

Both PASS. Recovery test binary SHA256:
`847c31fde9d920b3f89a79d54ff407a38a8c4e827c4a12aeb974a48010109660`.

## Exact transaction checkpoint handoff

Core62b8f2d90e4796885817083efbb9c21f501a1614 supplies opt-in checkpoint enum,
ordinary-owner authenticated arming and shared visibility. Migration602df8e2 adds
only four feature-gated calls after all ledger writes/readback before COMMIT and
after COMMIT before returning. Names are history-import-before-commit,
history-import-after-commit, history-rollback-before-commit and
history-rollback-after-commit. Errors map to HistoryError::Unavailable. No callback,
SQL, activation or alternate writer is introduced. With the feature absent the
calls do not compile into the binary; with it present but unarmed they return.

Disposable Core62b plus exact602 subtree: feature-enabled compile and same nine
checks and strict feature all-target clippy PASS. Eleven manifest/lock/toolchain files remain unchanged. Feature-enabled binary SHA256: `46299eb431a0100797de2af47f5cc1126318b4a0990c84024c8667b72a08c099`. Independent SIGKILL acceptance remains UNEXECUTED by Migration;
Verification received the exact hashes and owns its execution. Marker-free tests
prove build compatibility, not that a marker boundary was reached.

The new core_history.py pure producer maps complete collect_pages output to exact
Core fields and binary digest, refusing partial pages/unsupported actor/invalid
namespace. Credentials remain separate caller authority. It validates immutable
revision1 import receipts, including replay after rollback; current inactive
receipt interpretation is a different operation. It replaces no Store or route.
The old dormant_history.py remains an explicitly proposed-port historical oracle,
not a registered apply adapter. No live adapter or live import is enabled.
