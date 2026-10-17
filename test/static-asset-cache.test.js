import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../apps/server/src/server.js";

test("app assets revalidate without being downloaded again while HTML and API data stay uncached", async () => {
  const before = process.env.ORKESTR_HOME;
  process.env.ORKESTR_HOME = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-asset-cache-"));
  const server = await startServer({ host: "127.0.0.1", port: 0 });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const asset = await fetch(`${base}/main.js`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("content-type"), /javascript/);
    assert.equal(asset.headers.get("cache-control"), "private, max-age=0, must-revalidate");
    const etag = asset.headers.get("etag");
    assert.ok(etag);
    await asset.arrayBuffer();
    const repeated = await fetch(`${base}/main.js`, { cache: "no-cache", headers: { "if-none-match": etag } });
    assert.equal(repeated.status, 304);
    assert.equal((await repeated.arrayBuffer()).byteLength, 0);
    for (const route of ["/settings", "/missing-bundle.js", "/api/system/summary"]) {
      const response = await fetch(`${base}${route}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store", route);
      await response.arrayBuffer();
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
    if (before === undefined) delete process.env.ORKESTR_HOME;
    else process.env.ORKESTR_HOME = before;
  }
});
