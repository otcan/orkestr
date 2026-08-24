import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../apps/server/src/server.js";
import { appendThreadMessage, createThread } from "../packages/core/src/threads.js";

function restoreEnv(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test("sandbox artifact APIs project controlled downloads and return durable bytes and metadata", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-sandbox-artifact-api-"));
  const workspace = path.join(home, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  const sourcePath = path.join(workspace, "sample bundle.zip");
  const bytes = Buffer.from("synthetic zip bytes");
  await fs.writeFile(sourcePath, bytes);
  const keys = [
    "ORKESTR_HOME",
    "ORKESTR_AUTH_REQUIRED",
    "ORKESTR_UNSAFE_ALLOW_PUBLIC_UNAUTHENTICATED",
    "ORKESTR_WHATSAPP_AUTOSTART",
    "WHATSAPP_LOCAL_AUTOSTART",
  ];
  const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_AUTH_REQUIRED = "0";
  process.env.ORKESTR_UNSAFE_ALLOW_PUBLIC_UNAUTHENTICATED = "1";
  process.env.ORKESTR_WHATSAPP_AUTOSTART = "0";
  process.env.WHATSAPP_LOCAL_AUTOSTART = "0";
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const thread = await createThread({
      id: "sandbox-artifact-api-thread",
      name: "Sandbox Artifact API Thread",
      ownerUserId: "admin",
      cwd: workspace,
      workspace,
      executorId: "noop",
      executor: { id: "noop", type: "noop" },
    });
    const encoded = sourcePath.split(path.sep).map(encodeURIComponent).join("/");
    const message = await appendThreadMessage(thread.id, {
      role: "assistant",
      source: "codex-rollout",
      phase: "final_answer",
      text: `[Download](sandbox:/${encoded.replace(/^\/+/, "")})`,
    });
    await fs.rm(sourcePath);

    const messageResponse = await fetch(`${baseUrl}/api/threads/${thread.id}/messages`);
    assert.equal(messageResponse.status, 200);
    const page = await messageResponse.json();
    const projected = page.messages.find((item) => item.id === message.id);
    assert.ok(projected);
    assert.equal(projected.attachments.length, 1);
    assert.match(projected.attachments[0].downloadUrl, /^\/api\/threads\/sandbox-artifact-api-thread\/attachments\/att_[a-f0-9]{32}\/download$/);
    assert.doesNotMatch(projected.text, /sandbox:/i);

    const historyResponse = await fetch(`${baseUrl}/api/threads/${thread.id}/history`);
    assert.equal(historyResponse.status, 200);
    const history = await historyResponse.json();
    const historical = history.messages.find((item) => item.id === message.id);
    assert.equal(historical.attachments[0].downloadUrl, projected.attachments[0].downloadUrl);

    const download = await fetch(`${baseUrl}${projected.attachments[0].downloadUrl}`);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("content-type"), "application/zip");
    assert.match(download.headers.get("content-disposition") || "", /filename="sample bundle\.zip"/);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    restoreEnv(prior);
  }
});
