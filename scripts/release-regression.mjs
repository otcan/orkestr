#!/usr/bin/env node
import {
  formatSummary,
  parseReleaseRegressionArgs,
  runReleaseRegression,
} from "./release-regression-core.mjs";

export {
  formatSummary,
  parseReleaseRegressionArgs,
  runReleaseRegression,
} from "./release-regression-core.mjs";

function usage() {
  return `Usage: npm run release:regression -- [options]

Options:
  --target NAME=URL          Add a target Orkestr API base URL. Repeatable.
  --base-url URL             Add an unnamed target URL. Repeatable.
  --header "Name: value"     Add a request header, for paired cookies or tokens.
  --artifact-dir PATH        Write detailed JSON artifacts here.
  --release-id ID            Release/check identifier for artifacts and messages.
  --desktop-slug SLUG        Require a specific desktop session to be listed.
  --allow-auth-blocked       Treat protected target APIs as skipped instead of failed.
  --execute                  Enable real chat injection checks.
  --thread THREAD_ID         Thread used by --execute chat injection.
  --linkedin-thread ID       LinkedIn-bound thread used by --execute delivery check.
  --message TEXT             Chat injection message.
  --expect TEXT              Expected final assistant reply for --thread.

Environment:
  ORKESTR_RELEASE_CHECK_URLS can be "local=http://127.0.0.1:19812,remote=https://example".
  ORKESTR_HOME controls the default artifact root.
`;
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  (async () => {
    const options = parseReleaseRegressionArgs(process.argv.slice(2), process.env);
    if (options.help) {
      console.log(usage());
      return;
    }
    const summary = await runReleaseRegression(options);
    console.log(formatSummary(summary));
    if (!summary.ok) process.exitCode = 1;
  })().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
