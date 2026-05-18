import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

test("docker image carries the agent runtime instead of requiring host Codex install", async () => {
  const dockerfile = await fs.readFile("Dockerfile", "utf8");
  const compose = await fs.readFile("docker-compose.yml", "utf8");
  const buildCompose = await fs.readFile("docker-compose.build.yml", "utf8");
  const envExample = await fs.readFile(".env.docker.example", "utf8");
  const publishWorkflow = await fs.readFile(".github/workflows/docker-publish.yml", "utf8");
  const ignore = await fs.readFile(".dockerignore", "utf8");

  assert.match(dockerfile, /npm install -g @openai\/codex@/);
  assert.match(dockerfile, /tmux/);
  assert.match(dockerfile, /ripgrep/);
  assert.match(dockerfile, /chromium/);
  assert.match(dockerfile, /CODEX_HOME=\/data\/codex/);
  assert.match(dockerfile, /ln -sf \/app\/apps\/cli\/bin\/orkestr-oss\.js \/usr\/local\/bin\/orkestr/);
  assert.match(dockerfile, /ln -sf \/app\/apps\/cli\/bin\/orkestr-oss\.js \/usr\/local\/bin\/orkestr-oss/);
  assert.match(compose, /ghcr\.io\/otcan\/orkestr:latest/);
  assert.match(compose, /ORKESTR_BIND_ADDRESS/);
  assert.match(compose, /ORKESTR_DOCKER_HOST_BIND_ADDRESS/);
  assert.match(compose, /ORKESTR_REVERSE_PROXY_LOCAL_BIND/);
  assert.match(compose, /OPENAI_API_KEY/);
  assert.match(compose, /ORKESTR_PUBLIC_HTTPS_URL/);
  assert.match(compose, /CODEX_HOME: \$\{CODEX_HOME:-\/data\/codex\}/);
  assert.match(buildCompose, /build:/);
  assert.match(envExample, /^OPENAI_API_KEY=/m);
  assert.match(envExample, /^ORKESTR_REVERSE_PROXY_LOCAL_BIND=/m);
  assert.match(envExample, /^ORKESTR_PUBLIC_HTTPS_URL=/m);
  assert.match(envExample, /^ORKESTR_TAILSCALE_HTTPS_NAME=/m);
  assert.match(publishWorkflow, /ghcr\.io/);
  assert.match(publishWorkflow, /docker\/build-push-action/);
  assert.match(ignore, /^\.env$/m);
  assert.match(ignore, /^secrets$/m);
  assert.match(ignore, /^browsers$/m);
});
