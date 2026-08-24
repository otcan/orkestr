#!/usr/bin/env node
import {
  executeLinkedInMcpPlan,
  parseLinkedInRuntimeArgs,
  readLinkedInMcpPlan,
  writeLinkedInRuntimeResult,
} from "../packages/core/src/linkedin-mcp-runtime.js";

function printHelp() {
  console.log(`linkedin-mcp-runtime

Usage:
  node scripts/linkedin-mcp-runtime.mjs --plan <mcp-plan.json> [options]

Options:
  --module <specifier>       Module/path exporting ork-linkedin runtime helpers.
                             Defaults to ORKESTR_LINKEDIN_MODULE or "ork-linkedin".
  --bindings <file>          Private LinkedIn outreach binding registry.
                             Defaults to ORKESTR_LINKEDIN_OUTREACH_BINDINGS_FILE.
  --desktop <slug>           Exact managed desktop slug. Defaults to the scoped plan.
  --thread-id <id>           Desktop lease owner thread id.
  --thread-name <name>       Desktop lease display name.
  --owner-user-id <id>       Optional tenant owner.
  --output <file>            Write structured execution result.
  --force-lease              Force-acquire the desktop lease.
  --no-release               Keep the lease after execution.
  --continue-on-blocker      Continue after blocked/failed call.
  --accept-preverified-writes
                             Accept approvals that already carry verifiedSend evidence.

Every plan must provide threadId, desktopSlug, bindingId, outreachWorkspaceId,
and linkedinAccountAlias matching exactly one configured binding. The raw oXRM
endpoint is resolved from that binding and is never emitted in runtime output.

The runtime uses Orkestr managed desktop leases. LinkedIn write calls fail
closed unless verified visible-send evidence is available; Orkestr must not use
CDP/DevTools to click, type, submit, or send LinkedIn actions.
`);
}

const options = parseLinkedInRuntimeArgs(process.argv.slice(2), process.env);
if (options.help) {
  printHelp();
  process.exit(0);
}

if (!options.planPath) {
  printHelp();
  process.exit(2);
}

const plan = await readLinkedInMcpPlan(options.planPath);
const result = await executeLinkedInMcpPlan(plan, options);
await writeLinkedInRuntimeResult(options.output, result);
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
