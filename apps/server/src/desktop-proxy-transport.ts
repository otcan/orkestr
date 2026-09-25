import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import { desktopProxyTimeout } from "./desktop-target.js";
import { observeHistogram } from "../../../packages/core/src/observability.js";

function timing(phase: string, start: number, outcome: string): void {
  observeHistogram("orkestr_desktop_proxy_phase_seconds", (performance.now() - start) / 1000, { phase, outcome });
}

export function proxyDesktopAsset(request: any, response: any, target: { port: number; path: string }, env = process.env): void {
  const start = performance.now();
  const headers = { ...request.headers, host: `127.0.0.1:${target.port}` };
  delete headers.connection;
  delete headers.upgrade;
  let finished = false;
  let body: http.IncomingMessage | undefined;
  const finish = (outcome: string) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    timing("upstream_body", start, outcome);
  };
  const fail = (code: string, status = 502) => {
    if (finished) return;
    finish(code === "desktop_upstream_timeout" ? "timeout" : "error");
    upstream.destroy();
    body?.destroy();
    if (response.destroyed) return;
    if (response.headersSent) response.destroy();
    else {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false, error: code }));
    }
  };
  const timer = setTimeout(() => fail("desktop_upstream_timeout", 504),
    desktopProxyTimeout(env, "ORKESTR_DESKTOP_PROXY_HTTP_TIMEOUT_MS", 15_000));
  timer.unref();
  const upstream = http.request({
    host: "127.0.0.1", port: target.port, method: request.method, path: target.path, headers,
  }, (incoming) => {
    body = incoming;
    if (finished || response.destroyed) { incoming.destroy(); return; }
    timing("upstream_headers", start, "ok");
    response.writeHead(incoming.statusCode || 502, incoming.headers);
    incoming.once("error", () => fail("desktop_proxy_failed"));
    incoming.once("aborted", () => fail("desktop_proxy_failed"));
    incoming.pipe(response);
  });
  upstream.once("error", () => fail("desktop_proxy_failed"));
  response.once("finish", () => finish("ok"));
  response.once("close", () => { finish("closed"); upstream.destroy(); body?.destroy(); });
  request.once("aborted", () => { finish("closed"); upstream.destroy(); body?.destroy(); });
  request.pipe(upstream);
}

export function proxyDesktopSocket(
  socket: Duplex, head: Buffer, port: number, headers: string,
  onConnected: (upstream: Duplex) => void, env = process.env,
): void {
  const start = performance.now();
  let settled = false;
  let buffered = Buffer.alloc(0);
  const upstream = net.connect(port, "127.0.0.1", () => {
    upstream.write(headers);
    if (head.length) upstream.write(head);
  });
  const fail = (code: string, status = 502) => {
    if (settled) { socket.destroy(); upstream.destroy(); return; }
    settled = true;
    clearTimeout(timer);
    timing("websocket_handshake", start, status === 504 ? "timeout" : "error");
    upstream.destroy();
    // Do not wait for the peer's FIN after rejection: an allowHalfOpen client
    // can otherwise retain this socket after the handshake timer is cleared.
    if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} Bad Gateway\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(code)}\r\n\r\n${code}`, () => socket.destroy());
  };
  const timer = setTimeout(() => fail("desktop_websocket_timeout", 504),
    desktopProxyTimeout(env, "ORKESTR_DESKTOP_PROXY_WS_TIMEOUT_MS", 10_000));
  timer.unref();
  const onData = (chunk: Buffer) => {
    if (settled) return;
    buffered = Buffer.concat([buffered, chunk]);
    const end = buffered.indexOf("\r\n\r\n");
    if (end < 0 && buffered.length <= 16_384) return;
    if (end < 0 || end > 16_384 || !/^HTTP\/1\.[01] 101\s/.test(buffered.toString("latin1", 0, Math.min(end, 80)))) {
      fail("desktop_websocket_upgrade_failed"); return;
    }
    settled = true;
    clearTimeout(timer);
    timing("websocket_handshake", start, "ok");
    upstream.removeListener("data", onData);
    socket.write(buffered);
    buffered = Buffer.alloc(0);
    socket.pipe(upstream).pipe(socket);
    onConnected(upstream);
  };
  upstream.on("data", onData);
  upstream.once("error", () => fail("desktop_proxy_failed"));
  upstream.once("end", () => { if (!settled) fail("desktop_websocket_upgrade_failed"); });
  socket.once("error", () => upstream.destroy());
  socket.once("close", () => { clearTimeout(timer); upstream.destroy(); });
  upstream.once("close", () => {
    if (!settled) { fail("desktop_websocket_upgrade_failed"); return; }
    clearTimeout(timer);
    if (!socket.writableEnded) socket.destroy();
  });
}
