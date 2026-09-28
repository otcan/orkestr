// Turns the output of a detached `deploy-git-release.sh install` run into a
// small structured result that `orkestr update status --deploy-id` and the
// post-deploy thread report can show without re-reading the whole log.

export const DEPLOY_EXIT_REMOTE_PARTIAL = 3;
export const DEPLOY_EXIT_BLOCKED = 75;

const FANOUT_LINE = /^(deployed|failed|skipped)\s+(\S+)\s*(.*)$/;

export function deployOutcome(exitCode, summary = {}) {
  if (summary.lockBusy) return "blocked";
  if (exitCode === 0) return "success";
  if (exitCode === DEPLOY_EXIT_REMOTE_PARTIAL && summary.releaseId) return "partial_remote";
  if (exitCode === DEPLOY_EXIT_BLOCKED) return "blocked";
  return "failed";
}

export function summarizeDeployLog(text = "") {
  const summary = {
    releaseId: "",
    commit: "",
    smokePassed: false,
    healthChecksPassed: false,
    exposure: "",
    lockBusy: false,
    blockedReason: "",
    fanout: [],
    workerSync: "",
    lastError: "",
  };
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const deployed = line.match(/^Orkestr deployed (\S+) \(([0-9a-f]{7,40})\)\.?$/);
    // A fan-out can deploy tenant instances too; the local release is the
    // last "Orkestr deployed" line printed by the outer deploy.
    if (deployed) {
      summary.releaseId = deployed[1];
      summary.commit = deployed[2];
      continue;
    }
    if (/^Smoke test passed/.test(line)) summary.smokePassed = true;
    if (/Deploy drain cleared after .* passed health checks/.test(line)) summary.healthChecksPassed = true;
    const exposure = line.match(/^Public exposure check (passed|skipped|failed)/);
    if (exposure) summary.exposure = exposure[1];
    if (/^Another Orkestr deploy is already running/.test(line)) summary.lockBusy = true;
    if (/^Refusing no-interrupt deploy|^Timed out waiting for active Orkestr thread work/.test(line)) summary.blockedReason = line;
    const fanout = line.match(FANOUT_LINE);
    if (fanout && !/^skipped\s+\S+\s+local_already_deployed/.test(line)) {
      const entry = { status: fanout[1], instance: fanout[2], detail: fanout[3].trim() };
      const existing = summary.fanout.findIndex((item) => item.instance === entry.instance);
      if (existing >= 0) summary.fanout[existing] = entry;
      else summary.fanout.push(entry);
      continue;
    }
    const sync = line.match(/^Post-deploy worker sync: (.*)$/);
    if (sync) summary.workerSync = sync[1];
    if (/(error|failed|refusing)/i.test(line) && !/^Post-deploy worker skipped/.test(line)) summary.lastError = line.slice(0, 300);
  }
  return summary;
}

export function formatDeployReport(result = {}) {
  const summary = result.summary || {};
  const lines = [];
  const headline = {
    success: "Deploy finished",
    partial_remote: "Deploy finished locally; some remote instances failed",
    blocked: "Deploy did not start",
    failed: "Deploy failed",
  }[result.outcome] || "Deploy finished";
  lines.push(`${headline} (${result.deployId || "deploy"}, exit ${result.exitCode ?? "?"}).`);
  if (summary.releaseId) lines.push(`Release: ${summary.releaseId}${summary.commit ? ` (${summary.commit.slice(0, 8)})` : ""}.`);
  const checks = [
    summary.smokePassed ? "smoke passed" : "",
    summary.healthChecksPassed ? "health checks passed" : "",
    summary.exposure ? `exposure check ${summary.exposure}` : "",
  ].filter(Boolean);
  if (checks.length) lines.push(`Checks: ${checks.join(", ")}.`);
  const failed = (summary.fanout || []).filter((item) => item.status === "failed").map((item) => item.instance);
  const deployed = (summary.fanout || []).filter((item) => item.status === "deployed").map((item) => item.instance);
  if (deployed.length || failed.length) {
    lines.push(`Instances: ${deployed.length} deployed${failed.length ? `, ${failed.length} failed (${failed.join(", ")})` : ""}.`);
  }
  if (summary.workerSync) lines.push(`Worker sync: ${summary.workerSync}`);
  if (result.outcome === "blocked") lines.push(summary.lockBusy ? "Another deploy was already running." : (summary.blockedReason || "Blocked by the deploy guard."));
  if (result.outcome === "failed" && summary.lastError) lines.push(`Last error: ${summary.lastError}`);
  if (result.logPath) lines.push(`Log: ${result.logPath}`);
  return lines.join("\n");
}
