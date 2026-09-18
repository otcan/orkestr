import fs from "node:fs/promises";
import { reportInputRepair, saveRepairManifest, applyInputRepair, rollbackInputRepair } from "../packages/core/src/codex-input-repair.js";

const args = process.argv.slice(2);
const value = flag => args[args.indexOf(flag) + 1];
const required = flag => { if (!args.includes(flag) || !value(flag) || value(flag).startsWith("--")) throw new Error(`${flag}_required`); return value(flag); };
if (args.includes("--help")) {
  console.log("Report (no history sync): --thread ID --owner ID --report /private/report.json\nApply reviewed report: --apply /private/report.json --approve-digest SHA256 --manifest /private/manifest.json\nRollback unchanged repaired snapshot: --rollback /private/manifest.json --approve-digest SHA256\nNo attachment bytes are read; no delivery/agent hooks execute. Reports/manifests are private and contain before-images.");
} else if (args.includes("--apply")) {
  const report = JSON.parse(await fs.readFile(required("--apply"), "utf8"));
  console.log(JSON.stringify(await applyInputRepair(report, { approvalDigest: required("--approve-digest"), manifestPath: required("--manifest") })));
} else if (args.includes("--rollback")) {
  console.log(JSON.stringify(await rollbackInputRepair(required("--rollback"), required("--approve-digest"))));
} else {
  const report = await reportInputRepair(required("--thread"), required("--owner"));
  await saveRepairManifest(required("--report"), report);
  console.log(JSON.stringify({ candidates: report.candidates.length, skipped: report.skipped.length, approvalDigest: report.approvalDigest, applied: false }));
}
