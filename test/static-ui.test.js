import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../apps/server/src/server.js";

function assertAngularShell(html) {
  assert.match(html, /<ork-root(?:\s|>)/);
  assert.ok(html.includes("Loading Orkestr"));
  assert.match(html, /src="main[^"]*\.js"/);
}

test("server serves the built Angular UI at root", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-static-ui-"));
  const priorHome = process.env.ORKESTR_HOME;
  const priorOverlay = process.env.ORKESTR_OVERLAY_DIR;
  process.env.ORKESTR_HOME = home;
  delete process.env.ORKESTR_OVERLAY_DIR;
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`);
    const html = await response.text();
    const onboardingResponse = await fetch(`http://127.0.0.1:${port}/setup`);
    const onboardingHtml = await onboardingResponse.text();
    const setupGmailResponse = await fetch(`http://127.0.0.1:${port}/setup/gmail`);
    const setupGoogleMarketingResponse = await fetch(`http://127.0.0.1:${port}/setup/google-marketing`);
    const workflowOnboardingResponse = await fetch(`http://127.0.0.1:${port}/onboarding`);
    const legacyOnboardingResponse = await fetch(`http://127.0.0.1:${port}/ng/onboarding`);
    const opsResponse = await fetch(`http://127.0.0.1:${port}/ops`);
    const threadResponse = await fetch(`http://127.0.0.1:${port}/thread/demo`);
    const googleMarketingStartResponse = await fetch(`http://127.0.0.1:${port}/google-marketing/oauth/start`, { redirect: "manual" });
    const googleMarketingStartHtml = await googleMarketingStartResponse.text();

    assert.equal(response.status, 200);
    assertAngularShell(html);
    assert.equal(onboardingResponse.status, 200);
    assertAngularShell(onboardingHtml);
    assert.equal(setupGmailResponse.status, 200);
    assert.equal(setupGoogleMarketingResponse.status, 200);
    assert.equal(workflowOnboardingResponse.status, 200);
    assert.equal(legacyOnboardingResponse.status, 200);
    assert.equal(opsResponse.status, 200);
    assert.equal(threadResponse.status, 200);
    assert.equal(googleMarketingStartResponse.status, 500);
    assert.ok(googleMarketingStartHtml.includes("Google Marketing auth failed"));
    assert.doesNotMatch(googleMarketingStartHtml, /<ork-root(?:\s|>)/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (priorHome === undefined) delete process.env.ORKESTR_HOME;
    else process.env.ORKESTR_HOME = priorHome;
    if (priorOverlay === undefined) delete process.env.ORKESTR_OVERLAY_DIR;
    else process.env.ORKESTR_OVERLAY_DIR = priorOverlay;
  }
});
