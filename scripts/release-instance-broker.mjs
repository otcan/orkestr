#!/usr/bin/env node
import { spawn } from "node:child_process";
import { verifyReleaseInstanceConnectivity } from "../packages/core/src/release-connectivity.js";
import {
  deployReleaseInstances,
  listReleaseInstances,
  publicReleaseInstance,
} from "../packages/core/src/release-instances.js";

function flagValue(argv, flag, fallback = "") {
  const index = argv.indexOf(flag);
  return index >= 0 ? String(argv[index + 1] || fallback) : fallback;
}

function hasFlag(argv, flag) {
  return argv.includes(flag);
}

function positiveInteger(value, fallback, minimum = 1) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.floor(parsed)) : fallback;
}

function commandName(argv = []) {
  return argv.find((value) => !value.startsWith("--")) || "list";
}

function shortCommit(value) {
  const text = String(value || "");
  return text.length > 12 ? text.slice(0, 12) : text;
}

function releaseDisplayLabel(version = {}) {
  const semanticVersion = String(version.releaseVersion || version.version || "").trim();
  return String(version.releaseLabel || version.tag || (semanticVersion ? `v${semanticVersion}` : "") || version.releaseId || version.describe || shortCommit(version.commit) || "-").trim();
}

function formatInstanceTable(instances = []) {
  if (!instances.length) return "No release instances registered.";
  const rows = instances.map((instance) => {
    const version = instance.currentVersion || {};
    const release = releaseDisplayLabel(version);
    const train = instance.kind === "local-service"
      ? "local"
      : instance.releaseTrainEnabled
      ? (instance.hasDeployCommand ? "ready" : "needs-command")
      : "disabled";
    return [
      instance.id || "-",
      instance.kind || "-",
      instance.status || "-",
      train,
      release,
      instance.baseUrl || instance.versionUrl || "-",
    ];
  });
  const widths = [10, 12, 10, 13, 12, 24].map((minimum, index) => Math.max(minimum, ...rows.map((row) => String(row[index] || "").length)));
  const header = ["ID", "KIND", "STATUS", "TRAIN", "RELEASE", "URL"].map((value, index) => value.padEnd(widths[index])).join("  ");
  const body = rows.map((row) => row.map((value, index) => String(value || "-").padEnd(widths[index])).join("  ")).join("\n");
  return `${header}\n${body}`;
}

function formatDeployResults(report = {}) {
  const results = Array.isArray(report.results) ? report.results : [];
  const deploymentLines = results.map((result) => {
    const detail = result.reason || result.error || (result.code !== undefined ? `exit=${result.code}` : "");
    return `${result.status.padEnd(8)} ${String(result.id || "-").padEnd(24)}${detail ? ` ${detail}` : ""}`;
  });
  const connectivity = Array.isArray(report.connectivity?.results) ? report.connectivity.results : [];
  const connectivityLines = connectivity.map((result) => {
    const detail = [
      result.error || result.method || "",
      result.attempts > 1 ? `attempts=${result.attempts}` : "",
      result.recoveryAttempts ? `recovery=${result.recoveryAttempts}` : "",
      result.lastRecoveryError ? `lastRecoveryError=${result.lastRecoveryError}` : "",
    ].filter(Boolean).join(" ");
    return `${result.status.padEnd(18)} ${String(result.id || "-").padEnd(24)}${detail ? ` ${detail}` : ""}`;
  });
  const lines = [
    ...(deploymentLines.length ? deploymentLines : ["No release instances matched."]),
    ...(connectivityLines.length ? ["", "Connectivity:", ...connectivityLines] : []),
  ];
  return lines.join("\n");
}

function usage() {
  return `Usage:
  scripts/release-instance-broker.mjs list [--probe] [--json]
  scripts/release-instance-broker.mjs plan [--ref REF] [--channel CHANNEL] [--json]
  scripts/release-instance-broker.mjs deploy [--ref REF] [--channel CHANNEL] [--concurrency N] [--include-local] [--dry-run] [--no-connectivity-check] [--json]

Environment:
  ORKESTR_RELEASE_FANOUT_CONCURRENCY controls deploy and connectivity fan-out. Defaults to 4.
`;
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasFlag(argv, "--help") || hasFlag(argv, "-h")) {
    process.stdout.write(usage());
    return;
  }
  const command = commandName(argv);
  const json = hasFlag(argv, "--json");
  const ref = flagValue(argv, "--ref", process.env.ORKESTR_DEPLOY_REF || process.env.ORKESTR_UPDATE_REF || "main");
  const channel = flagValue(argv, "--channel", process.env.ORKESTR_DEPLOY_CHANNEL || "production");
  const concurrency = flagValue(argv, "--concurrency", process.env.ORKESTR_RELEASE_FANOUT_CONCURRENCY || "");
  const instances = await listReleaseInstances(process.env, {
    probe: hasFlag(argv, "--probe"),
    fetchImpl: globalThis.fetch,
  });

  if (command === "list") {
    const payload = {
      instances: instances.map((instance) => publicReleaseInstance(instance)),
      generatedAt: new Date().toISOString(),
    };
    if (json) console.log(JSON.stringify(payload, null, 2));
    else console.log(formatInstanceTable(payload.instances));
    return;
  }

  if (command === "plan" || command === "deploy") {
    const report = await deployReleaseInstances({
      instances,
      ref,
      channel,
      dryRun: command === "plan" || hasFlag(argv, "--dry-run"),
      skipLocal: !hasFlag(argv, "--include-local"),
      ...(concurrency ? { concurrency: positiveInteger(concurrency, 4) } : {}),
      spawnImpl: spawn,
      fetchImpl: globalThis.fetch,
    }, process.env);
    if (command === "deploy" && !hasFlag(argv, "--dry-run") && !hasFlag(argv, "--no-connectivity-check") && report.ok) {
      report.connectivity = await verifyReleaseInstanceConnectivity(instances, {
        ref,
        channel,
        skipLocal: !hasFlag(argv, "--include-local"),
        connectivityAttempts: positiveInteger(process.env.ORKESTR_RELEASE_CONNECTIVITY_ATTEMPTS, 6),
        connectivityRetryDelayMs: positiveInteger(process.env.ORKESTR_RELEASE_CONNECTIVITY_RETRY_DELAY_MS, 15_000, 0),
        ...(concurrency ? { concurrency: positiveInteger(concurrency, 4) } : {}),
        connectivityRecoveryCommand: process.env.ORKESTR_RELEASE_CONNECTIVITY_RECOVERY_COMMAND || "",
        spawnImpl: spawn,
        fetchImpl: globalThis.fetch,
      }, process.env);
      report.ok = report.connectivity.ok;
    } else {
      report.connectivity = null;
    }
    if (json) console.log(JSON.stringify(report, null, 2));
    else console.log(formatDeployResults(report));
    if (!report.ok) process.exitCode = 1;
    return;
  }

  process.stderr.write(`Unknown command: ${command}\n\n${usage()}`);
  process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
