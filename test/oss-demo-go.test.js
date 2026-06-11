import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("OSS demo GO path exposes Docker, Helm, and k3s smoke contracts", async () => {
  const [dockerfile, entrypoint, chart, values, deployment, demoNotify, script, pkg] = await Promise.all([
    fs.readFile("Dockerfile", "utf8"),
    fs.readFile("docker-entrypoint.sh", "utf8"),
    fs.readFile("charts/orkestr/Chart.yaml", "utf8"),
    fs.readFile("charts/orkestr/values.yaml", "utf8"),
    fs.readFile("charts/orkestr/templates/deployment.yaml", "utf8"),
    fs.readFile("scripts/demo-vm-ready-notify.mjs", "utf8"),
    fs.readFile("scripts/smoke-k3s-oss-demo.mjs", "utf8"),
    fs.readFile("package.json", "utf8"),
  ]);

  await execFileAsync("node", ["--check", "scripts/demo-vm-ready-notify.mjs"]);
  await execFileAsync("node", ["--check", "scripts/smoke-k3s-oss-demo.mjs"]);
  assert.match(dockerfile, /ORKESTR_HOME=\/data/);
  assert.match(dockerfile, /EXPOSE 3000/);
  assert.match(dockerfile, /@openai\/codex@\$\{ORKESTR_CODEX_VERSION\}/);
  assert.match(dockerfile, /cloudflared-linux-\$\{cloudflared_arch\}/);
  assert.match(dockerfile, /cloudflared --version/);
  assert.match(entrypoint, /CODEX_HOME="\$\{CODEX_HOME:-\$ORKESTR_HOME\/codex\}"/);
  assert.match(chart, /name: orkestr/);
  assert.match(values, /ORKESTR_PORT: "3000"/);
  assert.match(values, /whatsappNumber: ""/);
  assert.match(values, /publicBaseUrl: ""/);
  assert.match(values, /cloudflareFallback: false/);
  assert.match(deployment, /mountPath: \/data/);
  assert.match(deployment, /ORKESTR_DEMO_WHATSAPP_NUMBER/);
  assert.match(deployment, /ORKESTR_DEMO_PUBLIC_BASE_URL/);
  assert.match(deployment, /ORKESTR_DEMO_CLOUDFLARE_FALLBACK/);
  assert.match(deployment, /ORKESTR_DEMO_CLOUDFLARE_DISABLE/);
  assert.match(demoNotify, /writeConnectorConfig\("whatsapp"/);
  assert.match(demoNotify, /trycloudflare/);
  assert.match(demoNotify, /browser-pairing challenge/);
  assert.match(script, /ORKESTR_K3S_OSS_DEMO_EXECUTE/);
  assert.match(script, /no-noop-demo-path/);
  assert.match(script, /private-vm-demo-bootstrap/);
  assert.match(pkg, /"smoke:k3s:oss-demo": "node scripts\/smoke-k3s-oss-demo\.mjs"/);
  assert.match(pkg, /"smoke:demo-vm": "node --test test\/demo-vm-bootstrap\.test\.js"/);
});
