#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const planOnly = args.includes("--plan");
const artifactIndex = args.indexOf("--artifact");
const artifact = artifactIndex >= 0 ? String(args[artifactIndex + 1] || "").trim() : "";

if (artifactIndex >= 0 && !artifact) {
  console.error("--artifact requires a path");
  process.exit(2);
}

export const canonicalUrlReleaseStages = [
  {
    id: "server_build",
    command: "npm",
    args: ["run", "build:server"],
    covers: ["server TypeScript", "HTTP and WebSocket ingress"],
  },
  {
    id: "web_build",
    command: "npm",
    args: ["run", "web:build"],
    covers: ["canonical browser navigation", "connect/app static assets"],
  },
  {
    id: "canonical_security_e2e",
    command: "node",
    args: [
      "--test",
      "test/canonical-public-references.test.js",
      "test/broker-instance-registration.test.js",
      "test/canonical-app-gateway.test.js",
      "test/canonical-app-links.test.js",
      "test/canonical-thread-navigation.test.js",
      "test/canonical-url-release-gate.test.js",
      "test/host-boundaries.test.js",
      "test/upgrade-forwarded-headers.test.js",
      "test/auth-config.test.js",
      "test/security.test.js",
      "test/system-doctor.test.js",
      "test/router-doctor.test.js",
      "test/static-ui.test.js",
    ],
    covers: [
      "opaque reference migration and collision safety",
      "instance-first local and broker authorization",
      "HTTP, SSE, and WebSocket proxying",
      "legacy redirect ambiguity and uniform denials",
      "app/connect host and session-cookie boundaries",
      "canonical notifications and browser navigation",
    ],
  },
  {
    id: "oss_boundary",
    command: "npm",
    args: ["run", "oss:boundary-check"],
    covers: ["public repository confidentiality boundary"],
  },
];

function publicPlan() {
  return canonicalUrlReleaseStages.map(({ id, command, args: commandArgs, covers }) => ({
    id,
    command: [command, ...commandArgs],
    covers,
  }));
}

async function writeArtifact(payload) {
  if (!artifact) return;
  const target = path.resolve(artifact);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
}

function run(stage) {
  return new Promise((resolve) => {
    const startedAt = new Date();
    const child = spawn(stage.command, stage.args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
      shell: false,
    });
    child.once("error", (error) => resolve({
      id: stage.id,
      ok: false,
      exitCode: null,
      error: error.code || error.name || "spawn_failed",
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
    }));
    child.once("exit", (code, signal) => resolve({
      id: stage.id,
      ok: code === 0,
      exitCode: code,
      signal: signal || "",
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
    }));
  });
}

const startedAt = new Date().toISOString();
const evidence = {
  schemaVersion: 1,
  gate: "canonical_urls",
  plan: publicPlan(),
  startedAt,
  finishedAt: startedAt,
  ok: false,
  results: [],
};

if (planOnly) {
  evidence.ok = true;
  evidence.finishedAt = new Date().toISOString();
  await writeArtifact(evidence);
  console.log(JSON.stringify(evidence, null, 2));
  process.exit(0);
}

for (const stage of canonicalUrlReleaseStages) {
  const result = await run(stage);
  evidence.results.push(result);
  if (!result.ok) break;
}
evidence.ok = evidence.results.length === canonicalUrlReleaseStages.length && evidence.results.every((item) => item.ok);
evidence.finishedAt = new Date().toISOString();
await writeArtifact(evidence);
console.log(JSON.stringify({
  gate: evidence.gate,
  ok: evidence.ok,
  artifact: artifact ? path.resolve(artifact) : "",
  results: evidence.results.map(({ id, ok, exitCode, signal }) => ({ id, ok, exitCode, signal })),
}, null, 2));
process.exit(evidence.ok ? 0 : 1);
