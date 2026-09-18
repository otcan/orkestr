import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { proxyDesktopAsset, proxyDesktopSocket } from "../dist/server/apps/server/src/desktop-proxy-transport.js";

async function listen(t, server) {
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return server.address().port;
}

function readHttp(port) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/asset.js`, (response) => {
      let body = "";
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body, aborted: false }));
      response.on("aborted", () => resolve({ status: response.statusCode, body, aborted: true }));
      response.on("error", () => {});
    });
    req.on("error", reject);
  });
}

test("HTTP assets preserve responses and bound stalled headers and bodies, including error bodies", async (t) => {
  for (const mode of ["ok", "error", "headers-stall", "body-stall", "error-stall"]) {
    await t.test(mode, async (t) => {
      let closed = false;
      const port = await listen(t, http.createServer((request, response) => {
        request.socket.once("close", () => { closed = true; });
        if (mode === "headers-stall") return;
        response.writeHead(mode.startsWith("error") ? 503 : 200, { "content-type": "text/plain" });
        response.write("fixture");
        if (!mode.endsWith("stall")) response.end();
      }));
      const proxy = await listen(t, http.createServer((req, res) => proxyDesktopAsset(req, res,
        { port, path: req.url }, { ORKESTR_DESKTOP_PROXY_HTTP_TIMEOUT_MS: "100" })));
      const started = performance.now();
      const result = await readHttp(proxy);
      assert.ok(performance.now() - started < 1500);
      assert.equal(result.status, mode === "headers-stall" ? 504 : mode.startsWith("error") ? 503 : 200);
      assert.equal(result.aborted, mode === "body-stall" || mode === "error-stall");
      if (mode === "headers-stall") assert.match(result.body, /desktop_upstream_timeout/);
      else assert.equal(result.body, "fixture");
      if (mode.endsWith("stall")) { await delay(20); assert.equal(closed, true); }
    });
  }
});

test("HTTP downstream cancellation closes the upstream without waiting for its deadline", async (t) => {
  let markClosed;
  const closed = new Promise((resolve) => { markClosed = resolve; });
  const port = await listen(t, http.createServer((req, res) => {
    req.socket.once("close", markClosed);
    res.writeHead(200); res.write("partial");
  }));
  const proxy = await listen(t, http.createServer((req, res) => proxyDesktopAsset(req, res, { port, path: "/" })));
  await new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${proxy}/`, (res) => res.once("data", () => {
      res.destroy(); req.destroy(); resolve();
    }));
    req.on("error", reject);
  });
  await Promise.race([closed, delay(1000).then(() => { throw Error("upstream not closed"); })]);
});

test("WebSocket upgrade deadlines cover stalls, trickling headers, invalid responses and abrupt close", async (t) => {
  for (const mode of ["stall", "trickle", "invalid", "oversize", "close"]) {
    await t.test(mode, async (t) => {
      let connected = 0;
      const port = await listen(t, net.createServer((socket) => {
        socket.on("error", () => {});
        socket.once("data", () => {
          if (mode === "invalid") socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
          if (mode === "oversize") socket.write("x".repeat(17_000));
          if (mode === "close") socket.destroy();
          if (mode === "trickle") {
            const interval = setInterval(() => socket.write("H"), 15);
            socket.once("close", () => clearInterval(interval));
          }
        });
      }));
      const proxy = await listen(t, net.createServer((socket) => proxyDesktopSocket(socket, Buffer.alloc(0), port,
        "GET / HTTP/1.1\r\n\r\n", () => { connected++; }, { ORKESTR_DESKTOP_PROXY_WS_TIMEOUT_MS: "100" })));
      const started = performance.now();
      const response = await new Promise((resolve, reject) => {
        const socket = net.connect(proxy, "127.0.0.1");
        let data = "";
        socket.on("data", (chunk) => { data += chunk; });
        socket.on("end", () => resolve(data));
        socket.on("error", reject);
      });
      assert.match(response, mode === "stall" || mode === "trickle" ? /^HTTP\/1.1 504/ : /^HTTP\/1.1 502/);
      assert.ok(performance.now() - started < 1500);
      assert.equal(connected, 0);
    });
  }
});

test("successful WebSocket upgrade forwards buffered bytes and remains open past handshake deadline", async (t) => {
  let connected = 0;
  const port = await listen(t, net.createServer((socket) => {
    socket.on("error", () => {});
    socket.once("data", () => {
      socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\ninitial-frame");
      socket.on("data", (data) => socket.write(data));
    });
  }));
  const proxy = await listen(t, net.createServer((socket) => proxyDesktopSocket(socket, Buffer.alloc(0), port,
    "GET / HTTP/1.1\r\n\r\n", () => { connected++; }, { ORKESTR_DESKTOP_PROXY_WS_TIMEOUT_MS: "100" })));
  const socket = net.connect(proxy, "127.0.0.1");
  t.after(() => socket.destroy());
  let data = "";
  socket.on("data", (chunk) => { data += chunk; });
  await delay(200);
  assert.equal(connected, 1);
  assert.equal(socket.destroyed, false);
  assert.match(data, /initial-frame$/);
  const echoed = new Promise((resolve) => socket.once("data", resolve));
  socket.write("later-frame");
  assert.equal(String(await echoed), "later-frame");
});
