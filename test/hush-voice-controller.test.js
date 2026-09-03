import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const controllerPath = path.resolve("apps/server/src/modules/mobile-voice/mobile-voice.controller.ts");
const runtimePath = path.resolve("packages/core/src/hush-voice-runtime.js");

test("Hush SSE starts promptly, never reflects raw stream errors, and closes after a terminal event", async () => {
  const source = await fs.readFile(controllerPath, "utf8");
  assert.match(source, /: hush connected/);
  assert.match(source, /: hush keep-alive/);
  assert.match(source, /mobile_voice_stream_unavailable/);
  assert.doesNotMatch(source, /String\(error\?\.message/);
  assert.match(source, /if \(terminalTurn\(event\)\) \{[\s\S]*?response\.end\(\)/);
  assert.match(source, /if \(terminalTurn\(\{ turn: current \}\)\) \{[\s\S]*?response\.end\(\)/);
  const runtime = await fs.readFile(runtimePath, "utf8");
  assert.doesNotMatch(runtime, /error\.message/);
});
