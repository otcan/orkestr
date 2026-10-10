// Child process for Agent Job failure-injection tests. Ops:
//   admit {spec, type, name, dedupeKey, body}   -> admits one run
//   drive {runId, faults}                        -> drives (faults may SIGKILL)
//   decide {approvalId, decision}                -> records one decision
import { admitRun } from "../../packages/core/src/agent-job-admission.js";
import { decideApproval } from "../../packages/core/src/agent-job-ledger.js";
import { driveRun } from "../../packages/core/src/agent-job-runner.js";

const [op, raw] = process.argv.slice(2);
const args = JSON.parse(raw || "{}");
try {
  let result;
  if (op === "admit") {
    const admitted = await admitRun(args, process.env);
    result = { runId: admitted.run.id, deduplicated: admitted.deduplicated };
  } else if (op === "drive") {
    result = await driveRun(args.runId, { faults: args.faults || [] }, process.env);
  } else if (op === "decide") {
    result = await decideApproval(args.approvalId, { decision: args.decision, by: `worker:${process.pid}` }, process.env);
  } else {
    throw new Error(`unknown op ${op}`);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: error?.code || error?.message })}\n`);
  process.exitCode = 2;
}
