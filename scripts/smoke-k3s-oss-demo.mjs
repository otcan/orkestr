#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const execute = ["1", "true", "yes"].includes(String(process.env.ORKESTR_K3S_OSS_DEMO_EXECUTE || "").toLowerCase());
const namespace = process.env.ORKESTR_K3S_OSS_DEMO_NAMESPACE || `orkestr-oss-demo-${Date.now().toString(36)}`;
const image = process.env.ORKESTR_K3S_OSS_DEMO_IMAGE || "orkestr/orkestr:oss-demo-smoke";

async function read(relativePath) {
  return fs.readFile(path.join(repoRoot, relativePath), "utf8");
}

async function commandAvailable(command) {
  try {
    await execFileAsync(command, ["--version"], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function request(pathname, port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: pathname, timeout: 5000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => body += chunk);
      res.on("end", () => resolve({ statusCode: res.statusCode, body }));
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("request_timeout"));
    });
  });
}

async function waitForHealth(port) {
  const deadline = Date.now() + 120_000;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const response = await request("/api/health", port);
      if (response.statusCode === 200 && /orkestr/i.test(response.body)) return response;
      last = new Error(`unexpected_health:${response.statusCode}:${response.body.slice(0, 120)}`);
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }
  throw last || new Error("health_timeout");
}

async function staticContractCheck() {
  const [dockerfile, entrypoint, demoNotify, chart, values, deployment, wizardTs, wizardHtml, pkg] = await Promise.all([
    read("Dockerfile"),
    read("docker-entrypoint.sh"),
    read("scripts/demo-vm-ready-notify.mjs"),
    read("charts/orkestr/Chart.yaml"),
    read("charts/orkestr/values.yaml"),
    read("charts/orkestr/templates/deployment.yaml"),
    read("apps/web/src/app/first-thread-wizard.component.ts"),
    read("apps/web/src/app/first-thread-wizard.component.html"),
    read("package.json"),
  ]);

  assert.match(dockerfile, /ORKESTR_HOME=\/data/);
  assert.match(dockerfile, /ORKESTR_PORT=3000/);
  assert.match(dockerfile, /@openai\/codex@\$\{ORKESTR_CODEX_VERSION\}/);
  assert.match(dockerfile, /ORKESTR_CHROME_NO_SANDBOX=1/);
  assert.match(entrypoint, /CODEX_HOME="\$\{CODEX_HOME:-\$ORKESTR_HOME\/codex\}"/);
  assert.match(entrypoint, /ORKESTR_DEMO_WHATSAPP_NUMBER/);
  assert.match(demoNotify, /runDemoVmReadyNotify/);
  assert.match(demoNotify, /writeConnectorConfig\("whatsapp"/);
  assert.match(demoNotify, /No public app URL is required/);
  assert.match(chart, /name: orkestr/);
  assert.match(values, /repository: orkestr\/orkestr/);
  assert.match(values, /ORKESTR_HOME: \/data/);
  assert.match(values, /ORKESTR_PORT: "3000"/);
  assert.match(values, /whatsappNumber: ""/);
  assert.match(values, /type: ClusterIP/);
  assert.match(deployment, /readinessProbe/);
  assert.match(deployment, /persistentVolumeClaim/);
  assert.match(deployment, /ORKESTR_DEMO_WHATSAPP_NUMBER/);
  assert.match(deployment, /ORKESTR_DEMO_WHATSAPP_RELAY_TOKEN/);
  assert.match(wizardTs, /threadName = "orkest"/);
  assert.match(wizardTs, /saveSetupDemoPreferences/);
  assert.match(wizardTs, /acquireDesktopLease/);
  assert.match(wizardTs, /browserAction\(slug, "start"/);
  assert.doesNotMatch(wizardTs, /executorId: "noop"/);
  assert.match(wizardHtml, /Use Orkestr relay/);
  assert.match(wizardHtml, /Use my own WhatsApp/);
  assert.match(wizardHtml, /Start orkest/);
  assert.match(pkg, /"smoke:k3s:oss-demo"/);
}

async function liveK3sSmoke() {
  for (const command of ["docker", "kubectl", "helm"]) {
    if (!await commandAvailable(command)) throw new Error(`missing_required_command:${command}`);
  }
  await execFileAsync("docker", ["build", "-t", image, "."], { cwd: repoRoot, stdio: "inherit" });
  await execFileAsync("kubectl", ["create", "namespace", namespace]);
  try {
    await execFileAsync("helm", [
      "install",
      "orkestr",
      "./charts/orkestr",
      "--namespace",
      namespace,
      "--set",
      `image.repository=${image.split(":")[0]}`,
      "--set",
      `image.tag=${image.split(":").slice(1).join(":") || "latest"}`,
      "--set",
      "image.pullPolicy=Never",
    ], { cwd: repoRoot, stdio: "inherit" });
    await execFileAsync("kubectl", ["rollout", "status", "deployment/orkestr", "--namespace", namespace, "--timeout=180s"], { stdio: "inherit" });
    const portForward = execFile("kubectl", ["port-forward", "service/orkestr", "3000:3000", "--namespace", namespace], { stdio: ["ignore", "ignore", "ignore"] });
    try {
      await waitForHealth(3000);
    } finally {
      portForward.kill("SIGTERM");
    }
  } finally {
    await execFileAsync("kubectl", ["delete", "namespace", namespace, "--wait=false"]).catch(() => {});
  }
}

await staticContractCheck();
if (execute) await liveK3sSmoke();

console.log(JSON.stringify({
  ok: true,
  execute,
  namespace: execute ? namespace : null,
  image: execute ? image : null,
  checks: [
    "docker-contract",
    "helm-contract",
    "first-run-orkest",
    "whatsapp-choice",
    "virtual-desk-start",
    "private-vm-demo-bootstrap",
    "one-whatsapp-number-input",
    "no-noop-demo-path",
  ],
}, null, 2));
