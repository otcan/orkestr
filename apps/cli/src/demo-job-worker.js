// One process lifetime of the `orkestr demo` job. Spawned by demo-command.js
// with an isolated ORKESTR_HOME; the injected fault may SIGKILL it.
import { runDemoJobAttempt } from "../../../packages/core/src/simulated-demo-job.js";

const options = JSON.parse(process.argv[2] || "{}");
try {
  const result = await runDemoJobAttempt(options, process.env);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${error?.message || String(error)}\n`);
  process.exitCode = 1;
}
