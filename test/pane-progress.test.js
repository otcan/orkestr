import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  cachedPaneProgress,
  clearPaneProgressCache,
  codexModeFromPaneText,
  paneProgressFromText,
  samplePaneProgress,
} from "../packages/core/src/pane-progress.js";

test("pane progress classifies active Codex work from the pane tail", () => {
  const progress = paneProgressFromText("◦ Working (2s • esc to interrupt)\n", { tailLines: 10 });

  assert.equal(progress.stateHint, "working");
  assert.equal(progress.summary, "Working");
  assert.equal(progress.working, true);
});

test("pane progress caches active samples for the VM-safe default window", async () => {
  clearPaneProgressCache();
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-pane-progress-cache-"));
  const bin = path.join(home, "bin");
  await fs.mkdir(bin, { recursive: true });
  const tmuxPath = path.join(bin, "tmux");
  await fs.writeFile(
    tmuxPath,
    "#!/usr/bin/env bash\nprintf '◦ Working (2s • esc to interrupt)\\n'\n",
    "utf8",
  );
  await fs.chmod(tmuxPath, 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH || ""}`,
  };
  const progress = await samplePaneProgress({ threadId: "active-cache-thread", paneId: "%1" }, env);
  const cached = cachedPaneProgress({ threadId: "active-cache-thread" }, env);

  assert.equal(progress.stateHint, "working");
  assert.equal(progress.cached, false);
  assert.equal(cached?.cached, true);
  assert.equal(cached?.stateHint, "working");
  assert.ok(Number(cached?.sampledAtMs || 0) + 5000 > Date.now());
  clearPaneProgressCache();
});

test("pane progress classifies visible background terminal work", () => {
  const progress = paneProgressFromText([
    "◦ Waiting for background terminal (45s • esc to interrupt)",
    "› Implement {feature}",
    "",
    "  gpt-5.5 xhigh · /workspace/demo",
  ].join("\n"), { tailLines: 10 });

  assert.equal(progress.stateHint, "working");
  assert.equal(progress.working, true);
  assert.equal(progress.backgroundWork, true);
  assert.equal(progress.promptReady, false);
});

test("pane progress keeps active foreground work when Codex redraws the prompt line", () => {
  const progress = paneProgressFromText([
    "◦ Working (2m 00s • esc to interrupt)",
    "› Write tests for @filename",
    "",
    "  gpt-5.5 xhigh · /workspace/demo",
  ].join("\n"), { tailLines: 10 });

  assert.equal(progress.stateHint, "working");
  assert.equal(progress.summary, "Working");
  assert.equal(progress.working, true);
  assert.equal(progress.promptReady, false);
});

test("pane progress classifies a ready prompt", () => {
  const progress = paneProgressFromText("All done.\n› \n", { tailLines: 10 });

  assert.equal(progress.stateHint, "ready");
  assert.equal(progress.summary, "Ready");
  assert.equal(progress.promptReady, true);
});

test("pane progress detects Codex conversation interruption banners", () => {
  const progress = paneProgressFromText([
    "■ Conversation interrupted - tell the model what to do differently.",
    "Something went wrong? Hit /feedback to report the issue.",
    "› ",
  ].join("\n"), { tailLines: 10 });

  assert.equal(progress.conversationInterrupted, true);
  assert.match(progress.conversationInterruptedLine, /Conversation interrupted/);
  assert.match(progress.conversationInterruptedHash, /^[a-f0-9]{64}$/);
  assert.equal(progress.promptReady, true);
});

test("pane progress exposes implementation prompts as plan progress", () => {
  const progress = paneProgressFromText([
    "Implement this plan?",
    "› 1. Yes, implement this plan",
    "  2. No, keep planning",
  ].join("\n"), { tailLines: 10 });

  assert.equal(progress.stateHint, "planning");
  assert.equal(progress.summary, "Implement plan?");
  assert.equal(progress.planImplementationReady, true);
});

test("pane progress ignores stale implementation prompts above the live prompt", () => {
  const progress = paneProgressFromText([
    "Implement this plan?",
    "› 1. Yes, implement this plan",
    "  2. No, keep planning",
    ...Array.from({ length: 20 }, (_, index) => `old output ${index}`),
    "Done.",
    "› ",
  ].join("\n"), { tailLines: 10 });

  assert.equal(progress.stateHint, "ready");
  assert.equal(progress.summary, "Ready");
  assert.equal(progress.planImplementationMenuVisible, false);
});

test("pane progress reads Codex mode from the latest status line", () => {
  const text = [
    "gpt-5.5 xhigh /workspace/demo            Plan mode",
    ...Array.from({ length: 20 }, (_, index) => `old output ${index}`),
    "gpt-5.5 xhigh /workspace/demo",
    "› ",
  ].join("\n");

  assert.equal(codexModeFromPaneText(text), "code");
});

test("pane progress keeps only a small stable tail", () => {
  const progress = paneProgressFromText(Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n"), {
    tailLines: 12,
  });

  assert.equal(progress.tailLines.length, 12);
  assert.equal(progress.tailLines[0], "line 19");
  assert.match(progress.tailHash, /^[a-f0-9]{64}$/);
});

test("pane progress marks recent delivery failures as errors", () => {
  const progress = paneProgressFromText("Command failed: tmux send-keys -t %580 C-m can't find pane: %580\n› \n", {
    tailLines: 10,
  });

  assert.equal(progress.stateHint, "error");
  assert.equal(progress.summary, "Error");
});

test("pane progress marks invalidated codex_apps auth as an auth error", () => {
  const progress = paneProgressFromText([
    "› hi",
    "",
    "⚠ MCP client for `codex_apps` failed to start: MCP startup failed: handshaking with MCP server failed.",
    "Unexpected content type: Some(\"text/plain; body: {\\\"error\\\":{\\\"message\\\":\\\"Your authentication token has been invalidated. Please try signing in again.\\\",\\\"code\\\":\\\"token_invalidated\\\"},\\\"status\\\":401}\")",
    "⚠ MCP startup incomplete (failed: codex_apps)",
    "› Use /skills to list available skills",
  ].join("\n"), {
    tailLines: 12,
  });

  assert.equal(progress.stateHint, "error");
  assert.equal(progress.summary, "Codex sign-in expired");
  assert.equal(progress.codexAuthInvalid, true);
  assert.equal(progress.codexAuthInvalidReason, "codex_token_invalidated");
});
