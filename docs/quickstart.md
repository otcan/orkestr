# Quickstart

## Try it in one minute

No API keys, no cloud account and no network access needed:

```bash
git clone https://github.com/otcan/orkestr.git
cd orkestr
npm ci
node apps/cli/bin/orkestr-oss.js demo --yes   # or: orkestr demo --yes
```

`orkestr demo` runs one durable Agent Job end to end with the built-in
`simulated` provider, inside a throwaway `ORKESTR_HOME` under your temp
directory:

1. **Trigger**: an API event queues the `repository-maintainer-demo` job.
2. **Tool call**: the agent opens a pull request against a local fake code
   host. The effect is recorded in the effect ledger under an idempotency key.
3. **Crash**: the worker process is killed with `SIGKILL` right after the pull
   request was opened, before the result was recorded.
4. **Recovery**: a new process recovers the interrupted execution, resumes the
   job and reconciles the pending effect against the fake code host. It finds
   the existing pull request and does **not** open a second one.
5. **Approval**: merging is an `approval_required` action. The job pauses until
   it is approved (`--yes` auto-approves; otherwise you are prompted).
6. **Completed**: the job records its final answer and the demo prints the
   audit trail and a list of guarantee checks.

The command exits non-zero if any guarantee is violated (for example a duplicate
pull request or a merge without approval).

Options:

- `--yes` approve automatically (needed in non-interactive shells)
- `--no-crash` skip the injected crash
- `--keep` keep the temporary `ORKESTR_HOME` for inspection
- `--json` print a machine-readable report

The same demo runs in CI without network access
(`test/simulated-provider.test.js`), so contributors can run the full test
suite without credentials.

### What the demo uses

- `packages/core/src/simulated-provider.js`: deterministic provider registered
  as executor `simulated`. It has no tool loop of its own, so Orkestr runs its
  tool calls.
- `packages/core/src/effect-ledger.js`: generic durable ledger for external side
  effects (`pending_approval -> approved -> started -> committed`). After a
  crash, an effect left in `started` must be reconciled with the external
  system before it may run again.
- The existing executor layer (`packages/core/src/executors.js`), thread
  messages, execution records and the event log for the audit trail.

## Next steps

Connect a real provider (Codex or Claude Code) and create your first thread
from the setup wizard. See the [README](../README.md#quickstart).
