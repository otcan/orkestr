import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { attachDesktopProxyUpgrade } from "../dist/server/apps/server/src/desktop-proxy.js";

test("malformed desktop upgrade encoding is rejected without an unhandled rejection", async t => {
  const prior = process.env.ORKESTR_HOST_BOUNDARIES;
  process.env.ORKESTR_HOST_BOUNDARIES = "0";
  t.after(() => {
    if (prior === undefined) delete process.env.ORKESTR_HOST_BOUNDARIES;
    else process.env.ORKESTR_HOST_BOUNDARIES = prior;
  });
  const server = new EventEmitter();
  attachDesktopProxyUpgrade(server);
  const handler = server.listeners("upgrade")[0];
  for (const slug of ["%ZZ", "%E0%A4%A"]) {
    const socket = new PassThrough();
    let response = "";
    socket.on("data", chunk => { response += chunk; });
    await assert.doesNotReject(handler({ url: `/desktop/${slug}/websockify`,
      headers: { host: "localhost" }, rawHeaders: [] }, socket, Buffer.alloc(0)));
    assert.match(response, /^HTTP\/1.1 400 /);
    assert.equal(socket.destroyed, true);
  }
});
