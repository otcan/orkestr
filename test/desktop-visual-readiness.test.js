import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

async function listen(handler = (socket) => socket.end()) {
  const server = net.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    server,
    port: typeof address === "object" && address ? address.port : 0,
  };
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

async function fakeRfbServer(pixelValue) {
  return listen((socket) => {
    let buffered = Buffer.alloc(0);
    let stage = "version";
    const serverInit = Buffer.alloc(24);
    serverInit.writeUInt16BE(192, 0);
    serverInit.writeUInt16BE(128, 2);
    serverInit[4] = 32;
    serverInit[5] = 24;
    serverInit[7] = 1;
    serverInit.writeUInt16BE(255, 8);
    serverInit.writeUInt16BE(255, 10);
    serverInit.writeUInt16BE(255, 12);
    serverInit[14] = 16;
    serverInit[15] = 8;

    const sendFrame = (request) => {
      const x = request.readUInt16BE(2);
      const y = request.readUInt16BE(4);
      const width = request.readUInt16BE(6);
      const height = request.readUInt16BE(8);
      const header = Buffer.alloc(16);
      header.writeUInt16BE(1, 2);
      header.writeUInt16BE(x, 4);
      header.writeUInt16BE(y, 6);
      header.writeUInt16BE(width, 8);
      header.writeUInt16BE(height, 10);
      socket.write(Buffer.concat([header, Buffer.alloc(width * height * 4, pixelValue)]));
    };

    const consume = () => {
      while (true) {
        if (stage === "version") {
          if (buffered.length < 12) return;
          buffered = buffered.subarray(12);
          socket.write(Buffer.from([1, 1]));
          stage = "security";
          continue;
        }
        if (stage === "security") {
          if (buffered.length < 1) return;
          buffered = buffered.subarray(1);
          socket.write(Buffer.alloc(4));
          stage = "client-init";
          continue;
        }
        if (stage === "client-init") {
          if (buffered.length < 1) return;
          buffered = buffered.subarray(1);
          socket.write(serverInit);
          stage = "messages";
          continue;
        }
        if (stage !== "messages" || !buffered.length) return;
        const type = buffered[0];
        const messageSize = type === 0 ? 20 : type === 2 ? 8 : type === 3 ? 10 : 1;
        if (buffered.length < messageSize) return;
        const message = buffered.subarray(0, messageSize);
        buffered = buffered.subarray(messageSize);
        if (type === 3) sendFrame(message);
      }
    };

    socket.write(Buffer.from("RFB 003.008\n", "ascii"));
    socket.on("data", (chunk) => {
      buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
      consume();
    });
  });
}

async function browserctlSession(pixelValue) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-desktop-visual-"));
  const web = await listen();
  const cdp = await listen();
  const rfb = await fakeRfbServer(pixelValue);
  try {
    const stateDir = path.join(home, "browsers", "desktop");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(path.join(stateDir, "desktop.json"), `${JSON.stringify({
      slug: "desktop",
      preparedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      xvfbPid: process.pid,
      windowManagerPid: process.pid,
      x11vncPid: process.pid,
      websockifyPid: process.pid,
      chromePid: process.pid,
      webPort: web.port,
      debugPort: cdp.port,
      vncPort: rfb.port,
      display: ":90",
    })}\n`);
    const { stdout } = await execFileAsync(process.execPath, [path.resolve("scripts/browserctl.mjs"), "list", "--json"], {
      env: { ...process.env, ORKESTR_HOME: home, ORKESTR_DESKTOP_VISUAL_PROBE_TIMEOUT_MS: "1000" },
    });
    return JSON.parse(stdout).sessions.find((session) => session.slug === "desktop");
  } finally {
    await Promise.all([close(web.server), close(cdp.server), close(rfb.server)]);
  }
}

test("browserctl rejects black and white RFB framebuffers even when process and web checks pass", async () => {
  const black = await browserctlSession(0);
  const white = await browserctlSession(255);

  assert.equal(black.status, "degraded");
  assert.equal(black.visual_ok, false);
  assert.equal(black.readiness.status, "black_frame");
  assert.equal(black.readiness.framebuffer.status, "black_frame");

  assert.equal(white.status, "degraded");
  assert.equal(white.visual_ok, false);
  assert.equal(white.readiness.status, "white_frame");
  assert.equal(white.readiness.framebuffer.status, "white_frame");
});
