import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../apps/server/src/server.js";

async function request(baseUrl, route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  assert.ok(response.ok, `${route} returned ${response.status}`);
  return response.json();
}

test("server exposes health, readiness, version, and agent message APIs", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-"));
  const priorHome = process.env.ORKESTR_HOME;
  process.env.ORKESTR_HOME = home;
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const health = await request(baseUrl, "/api/health");
    const ready = await request(baseUrl, "/api/ready");
    const version = await request(baseUrl, "/api/version");
    const queued = await request(baseUrl, "/api/agents/job-search-assistant/messages", {
      method: "POST",
      body: JSON.stringify({ text: "hello" }),
    });
    const execution = await request(baseUrl, "/api/agents/job-search-assistant/run-next", {
      method: "POST",
      body: JSON.stringify({ executorId: "noop" }),
    });
    const listed = await request(baseUrl, "/api/agents/job-search-assistant/messages");
    const system = await request(baseUrl, "/api/system/summary");
    const processes = await request(baseUrl, "/api/system/processes?sort=cpu");
    const browsers = await request(baseUrl, "/api/browsers");
    const browserSessions = await request(baseUrl, "/api/browser-sessions");
    const preparedBrowser = await request(baseUrl, "/api/browser-sessions/linkedin/prepare", { method: "POST" });
    const createdThread = await request(baseUrl, "/api/threads", {
      method: "POST",
      body: JSON.stringify({ name: "mode-test", codexModel: "gpt-test" }),
    });
    const mode = await request(baseUrl, `/api/threads/${createdThread.thread.id}/codex-mode`, {
      method: "POST",
      body: JSON.stringify({ mode: "plan" }),
    });
    const form = new FormData();
    form.append("files", new Blob(["hello attachment"], { type: "text/plain" }), "hello.txt");
    const uploadResponse = await fetch(`${baseUrl}/api/threads/${createdThread.thread.id}/uploads`, {
      method: "POST",
      body: form,
    });
    assert.ok(uploadResponse.ok, `/uploads returned ${uploadResponse.status}`);
    const upload = await uploadResponse.json();

    assert.equal(health.ok, true);
    assert.equal(ready.ok, true);
    assert.equal(version.name, "orkestr-oss");
    assert.equal(queued.message.state, "queued");
    assert.equal(execution.execution.state, "completed");
    assert.equal(listed.messages.length, 2);
    assert.equal(listed.messages[0].state, "completed");
    assert.equal(listed.messages[1].role, "assistant");
    assert.ok(system.cpu.count >= 1);
    assert.ok(Array.isArray(processes.processes));
    assert.ok(browsers.browsers.some((browser) => browser.slug === "linkedin"));
    assert.ok(browserSessions.sessions.some((session) => session.slug === "linkedin"));
    assert.equal(preparedBrowser.browser.slug, "linkedin");
    assert.equal(mode.thread.codexMode, "plan");
    assert.equal(mode.thread.codexModel, "gpt-test");
    assert.equal(upload.attachments[0].filename, "hello.txt");
    assert.equal(upload.attachments[0].mimetype, "text/plain");
    assert.ok(String(upload.attachments[0].saved_path || "").endsWith("hello.txt"));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (priorHome === undefined) delete process.env.ORKESTR_HOME;
    else process.env.ORKESTR_HOME = priorHome;
  }
});
