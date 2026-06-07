#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
  --orkestr-home PATH        Use PATH for artifacts and local CLI auth token lookup.
  --release-id ID            Release/check identifier for artifacts and messages.
  --desktop-slug SLUG        Require a specific desktop session to be listed.
  --required-whatsapp-accounts LIST
                             Comma/space-separated WA accounts that must be ready.
  --allow-auth-blocked       Treat protected target APIs as skipped instead of failed.
                             Does not skip required WA account readiness.
  --no-local-cli-auth        Do not auto-use ORKESTR_HOME/secrets/cli-auth.json
                             for loopback targets.
  --execute                  Enable real chat injection checks.
  --thread THREAD_ID         Thread used by --execute chat injection.
  --linkedin-thread ID       LinkedIn-bound thread used by --execute delivery check.
  --message TEXT             Chat injection message.
  --expect TEXT              Expected final assistant reply for --thread.

Environment:
  ORKESTR_RELEASE_CHECK_URLS can be "local=http://127.0.0.1:19812,remote=https://example".
  ORKESTR_RELEASE_REQUIRED_WHATSAPP_ACCOUNTS can require accounts such as sender,responder.
  ORKESTR_HOME controls the default artifact root.
`;
}

function realPathOrSelf(value) {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return path.resolve(value);
  }
}

function isMainModule() {
  if (!process.argv[1]) return false;
  return realPathOrSelf(process.argv[1]) === realPathOrSelf(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
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
