import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { inspectKubernetesPosture, planDisableTokenAutomount } from "./kubernetes-posture.mjs";
import { buildAwsAuditPlan, evaluateCredentialContainment } from "./aws-audit-plan.mjs";
import { planAliasRetirement, assessRegistrarReadiness } from "./domain-change-plan.mjs";
import { assessTransportResponse, traefikTransportMiddlewares } from "./transport-policy.mjs";
import { inspectCanonicalRouting } from "./canonical-routing-guard.mjs";

// JSON snapshots only. No provider credentials, network requests or apply mode.
export function reviewInfrastructure(mode, input) {
  switch (mode) {
    case "kubernetes": return inspectKubernetesPosture(input.objects, input.policy);
    case "automount-plan": return planDisableTokenAutomount(input.object, input.review);
    case "aws-audit-plan": return buildAwsAuditPlan(input);
    case "credential-metadata": return evaluateCredentialContainment(input);
    case "dns-plan": return planAliasRetirement(input);
    case "registrar": return assessRegistrarReadiness(input);
    case "transport": return assessTransportResponse(input.policy, input.protocol, input.response);
    case "transport-plan": return traefikTransportMiddlewares(input);
    case "canonical-routing": return inspectCanonicalRouting(input.config, { bindings: input.bindings });
    default: throw new Error("unknown_infrastructure_review_mode");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { mode: { type: "string" }, input: { type: "string" } } });
    if (!values.input || !path.isAbsolute(values.input)) throw new Error("absolute_snapshot_path_required");
    const handle = await fs.open(values.input, "r");
    let input;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error("bounded_snapshot_required");
      const buffer = Buffer.alloc(stat.size + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (offset > stat.size) throw new Error("snapshot_changed");
      input = JSON.parse(buffer.subarray(0, offset).toString("utf8"));
    } finally { await handle.close(); }
    const result = reviewInfrastructure(values.mode, input);
    console.log(JSON.stringify(result, null, 2));
    if (result.ok === false) process.exitCode = 2;
  } catch {
    // Never print malformed source, credentials or arbitrary parser messages.
    console.error("infrastructure_review_failed_no_readiness_claim");
    process.exitCode = 1;
  }
}
