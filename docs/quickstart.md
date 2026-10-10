# Quickstart

## Try it in one minute

No API keys, no cloud account and no network access needed:

```bash
git clone https://github.com/otcan/orkestr.git
cd orkestr
npm ci
node apps/cli/bin/orkestr-oss.js demo --yes   # or: orkestr demo --yes
```

`orkestr demo` runs the Agent Job in
[`examples/jobs/simulated-demo.yaml`](../examples/jobs/simulated-demo.yaml) on
the real Agent Job runner with the built-in `simulated` provider, inside a
throwaway `ORKESTR_HOME` under your temp directory:

1. **Trigger**: an API event admits one run of the `simulated-demo` job.
2. **Tool call**: the agent opens a pull request against a local fake code
   host. The call is authorized (default deny) and written to the effect
   ledger as `intended` before the external call.
3. **Crash**: the worker process is killed with `SIGKILL` right after the pull
   request was opened, before the effect was recorded as `committed`.
4. **Recovery**: a new process finds the dead lease holder, marks the attempt
   `interrupted` and reconciles the effect against the fake code host. It finds
   the existing pull request and does **not** open a second one.
5. **Approval**: merging is an `approval_required` action. The run parks in
   `awaiting_approval` until the approval (bound to the exact effect and its
   arguments) is granted. `--yes` auto-approves; otherwise you are prompted.
6. **Succeeded**: the run finishes, its audit record is sealed and the demo
   prints the journal and a list of guarantee checks.

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

## Your own job

```bash
orkestr init my-jobs          # writes my-jobs/jobs/hello-maintainer.yaml (simulated provider)
orkestr run my-jobs           # runs it; parks at the approval
orkestr jobs approvals
orkestr jobs approve <approval-id>
orkestr jobs list
orkestr jobs status <run-id>
```

See [the runner doc](spec/agent-job-runner.md) for triggers (API, webhook,
schedule), recovery and the guarantee tests, and
[`examples/repository-maintainer`](../examples/repository-maintainer) for a job
that works on a local git repository.

## Next steps

Connect a real provider (Codex or Claude Code) and create your first thread
from the setup wizard. See the [README](../README.md#quickstart).
