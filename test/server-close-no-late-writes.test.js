import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../apps/server/src/server.js";

// Regression: a WhatsApp delivery pass started at boot kept writing the
// connector-outbox mutation lock into ORKESTR_HOME after close() resolved, so
// a test's recursive cleanup failed with ENOTEMPTY (PR #16 CI run 38152463858).
test("nothing writes into ORKESTR_HOME after server.close() resolves", async (t) => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "orkestr-close-drain-"));
  const prior = { home: process.env.ORKESTR_HOME, recover: process.env.ORKESTR_RECOVER_RUNNING_ON_START };
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_RECOVER_RUNNING_ON_START = "0";
  t.after(async () => {
    if (prior.home === undefined) delete process.env.ORKESTR_HOME; else process.env.ORKESTR_HOME = prior.home;
    if (prior.recover === undefined) delete process.env.ORKESTR_RECOVER_RUNNING_ON_START; else process.env.ORKESTR_RECOVER_RUNNING_ON_START = prior.recover;
    await fsp.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  await fetch(`http://127.0.0.1:${server.address().port}/api/health`).then((response) => response.text());
  await new Promise((resolve) => server.close(resolve));
  const late = [];
  const watcher = fs.watch(home, { recursive: true }, (event, file) => late.push(`${event} ${file}`));
  await new Promise((resolve) => setTimeout(resolve, 1500));
  watcher.close();
  assert.deepEqual(late, [], "no file changes after close()");
});
