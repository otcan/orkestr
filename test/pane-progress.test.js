import assert from "node:assert/strict";
import test from "node:test";
import { codexModeFromPaneText, paneProgressFromText } from "../packages/core/src/pane-progress.js";

test("pane progress classifies active Codex work from the pane tail", () => {
  const progress = paneProgressFromText("◦ Working (2s • esc to interrupt)\n", { tailLines: 10 });

  assert.equal(progress.stateHint, "working");
  assert.equal(progress.summary, "Working");
  assert.equal(progress.working, true);
});

test("pane progress classifies a ready prompt", () => {
  const progress = paneProgressFromText("All done.\n› \n", { tailLines: 10 });

  assert.equal(progress.stateHint, "ready");
  assert.equal(progress.summary, "Ready");
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
