import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readOverlay } from "../packages/core/src/overlay.js";

test("overlay loader is optional and reads fake private overlay data", async () => {
  const overlayDir = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-overlay-"));
  const empty = await readOverlay({});
  assert.equal(empty.configured, false);

  await fs.writeFile(
    path.join(overlayDir, "overlay.json"),
    JSON.stringify({ name: "Example", agents: [{ id: "demo" }], timers: [{ label: "Daily demo" }] }, null, 2),
  );
  const overlay = await readOverlay({ ORKESTR_OVERLAY_DIR: overlayDir });
  assert.equal(overlay.configured, true);
  assert.equal(overlay.valid, true);
  assert.equal(overlay.agents[0].id, "demo");
});

