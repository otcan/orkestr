import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  verifyChromeDisplayIdentity,
  verifyPortOwnedByPid,
} from "../scripts/browserctl-port-identity.mjs";

const execFileAsync = promisify(execFile);

const HEADER = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";

function tcpRow({ portHex, state = "0A", inode = "1" }) {
  return `   0: 0100007F:${portHex} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000     0        0 ${inode} 1 0000000000000000 100 0 0 10 0`;
}

function tcp6Row({ portHex, state = "0A", inode = "1" }) {
  return `   0: 00000000000000000000000001000000:${portHex} 00000000000000000000000000000000:0000 ${state} 00000000:00000000 00:00000000 00000000     0        0 ${inode} 1 0000000000000000 100 0 0 10 0`;
}

function fakeFsDeps({ tcp = "", tcp6 = "", fds = {}, readFileError, listFdsError, readFdLinkErrors = {}, pidExists = true } = {}) {
  return {
    readFile: async (targetPath) => {
      if (readFileError) throw readFileError;
      if (targetPath === "/proc/net/tcp") return `${HEADER}\n${tcp}`;
      if (targetPath === "/proc/net/tcp6") return `${HEADER}\n${tcp6}`;
      throw Object.assign(new Error("unexpected_path"), { code: "ENOENT" });
    },
    listFds: async () => {
      if (listFdsError) throw listFdsError;
      return Object.keys(fds);
    },
    readFdLink: async (pid, fd) => {
      if (readFdLinkErrors[fd]) throw readFdLinkErrors[fd];
      return fds[fd];
    },
    pidExists: () => pidExists,
  };
}

// --- verifyPortOwnedByPid: correct owner -----------------------------------

test("verifyPortOwnedByPid: healthy when the recorded PID's fd table holds the listening socket's inode (IPv4)", async () => {
  const result = await verifyPortOwnedByPid({
    port: 8080,
    pid: 4242,
    deps: fakeFsDeps({
      tcp: `${tcpRow({ portHex: "1F90", inode: "999888" })}\n`,
      fds: { "3": "socket:[999888]", "0": "/dev/null" },
    }),
  });
  assert.deepEqual(result, { ok: true, status: "owned" });
});

test("verifyPortOwnedByPid: healthy when only the IPv6 table has the matching LISTEN row", async () => {
  const result = await verifyPortOwnedByPid({
    port: 8080,
    pid: 4242,
    deps: fakeFsDeps({
      tcp6: `${tcp6Row({ portHex: "1F90", inode: "777666" })}\n`,
      fds: { "4": "socket:[777666]" },
    }),
  });
  assert.deepEqual(result, { ok: true, status: "owned" });
});

// --- wrong owner -------------------------------------------------------

test("verifyPortOwnedByPid: unhealthy when the port is listening but a DIFFERENT process's fd holds it", async () => {
  const result = await verifyPortOwnedByPid({
    port: 8080,
    pid: 4242,
    deps: fakeFsDeps({
      tcp: `${tcpRow({ portHex: "1F90", inode: "999888" })}\n`,
      // The recorded PID's own fd table has sockets, just not this inode.
      fds: { "3": "socket:[111222]", "0": "/dev/null" },
    }),
  });
  assert.deepEqual(result, { ok: false, status: "wrong_process_on_port" });
});

test("verifyPortOwnedByPid: an unrelated listener on a DIFFERENT port is never mistaken for the expected one", async () => {
  const result = await verifyPortOwnedByPid({
    port: 8080,
    pid: 4242,
    deps: fakeFsDeps({
      tcp: `${tcpRow({ portHex: "1F91", inode: "999888" })}\n`, // port 8081, not 8080
      fds: { "3": "socket:[999888]" },
    }),
  });
  assert.deepEqual(result, { ok: false, status: "port_not_listening" });
});

// --- missing owner evidence / fail-closed -----------------------------

test("verifyPortOwnedByPid: fails closed when /proc/net/tcp(6) cannot be read at all", async () => {
  const result = await verifyPortOwnedByPid({
    port: 8080,
    pid: 4242,
    deps: fakeFsDeps({ readFileError: Object.assign(new Error("denied"), { code: "EACCES" }) }),
  });
  assert.deepEqual(result, { ok: false, status: "owner_evidence_unavailable" });
});

test("verifyPortOwnedByPid: fails closed when the recorded PID's fd directory cannot be read (permission denied)", async () => {
  const result = await verifyPortOwnedByPid({
    port: 8080,
    pid: 4242,
    deps: fakeFsDeps({
      tcp: `${tcpRow({ portHex: "1F90", inode: "999888" })}\n`,
      listFdsError: Object.assign(new Error("denied"), { code: "EACCES" }),
    }),
  });
  assert.deepEqual(result, { ok: false, status: "owner_evidence_unavailable" });
});

test("verifyPortOwnedByPid: a single unreadable fd entry does not itself fail closed if others resolve", async () => {
  const result = await verifyPortOwnedByPid({
    port: 8080,
    pid: 4242,
    deps: fakeFsDeps({
      tcp: `${tcpRow({ portHex: "1F90", inode: "999888" })}\n`,
      fds: { "3": "socket:[999888]", "5": "raced-away" },
      readFdLinkErrors: { "5": Object.assign(new Error("gone"), { code: "ENOENT" }) },
    }),
  });
  assert.deepEqual(result, { ok: true, status: "owned" });
});

// --- stale PID / PID reuse ----------------------------------------------

test("verifyPortOwnedByPid: unhealthy when the recorded PID is not running at all (stale/dead PID)", async () => {
  const result = await verifyPortOwnedByPid({
    port: 8080,
    pid: 4242,
    deps: fakeFsDeps({
      tcp: `${tcpRow({ portHex: "1F90", inode: "999888" })}\n`,
      fds: { "3": "socket:[999888]" },
      pidExists: false,
    }),
  });
  assert.deepEqual(result, { ok: false, status: "missing_owner_pid" });
});

test("verifyPortOwnedByPid: unhealthy when the recorded PID number was reused by a live but unrelated process", async () => {
  // The PID is alive (pidExists: true, matching a reused-PID scenario) but
  // its fd table -- belonging to whatever process now holds that PID number
  // -- has no fd for the port's current listening inode.
  const result = await verifyPortOwnedByPid({
    port: 8080,
    pid: 4242,
    deps: fakeFsDeps({
      tcp: `${tcpRow({ portHex: "1F90", inode: "999888" })}\n`,
      fds: { "0": "/dev/null", "1": "pipe:[555]", "2": "pipe:[556]" },
      pidExists: true,
    }),
  });
  assert.deepEqual(result, { ok: false, status: "wrong_process_on_port" });
});

test("verifyPortOwnedByPid: rejects an invalid port without touching any proc data", async () => {
  const result = await verifyPortOwnedByPid({ port: 0, pid: 4242, deps: fakeFsDeps() });
  assert.deepEqual(result, { ok: false, status: "port_invalid" });
});

// --- verifyChromeDisplayIdentity (implemented, not wired into the live
// readiness gate -- see the comment in scripts/browserctl.mjs) ------------

function environBuffer(pairs) {
  return Buffer.from(Object.entries(pairs).map(([key, value]) => `${key}=${value}`).join("\u0000") + "\u0000", "utf8");
}

test("verifyChromeDisplayIdentity: matches when the recorded PID's own environ DISPLAY equals the expected value", async () => {
  const result = await verifyChromeDisplayIdentity({
    pid: 777,
    expectedDisplay: ":90",
    deps: {
      readEnviron: async () => environBuffer({ PATH: "/usr/bin", DISPLAY: ":90" }),
      pidExists: () => true,
    },
  });
  assert.deepEqual(result, { ok: true, status: "matches" });
});

test("verifyChromeDisplayIdentity: fails closed (not a silent pass) when DISPLAY differs", async () => {
  const result = await verifyChromeDisplayIdentity({
    pid: 777,
    expectedDisplay: ":90",
    deps: {
      readEnviron: async () => environBuffer({ DISPLAY: ":91" }),
      pidExists: () => true,
    },
  });
  assert.deepEqual(result, { ok: false, status: "mismatched_display" });
});

test("verifyChromeDisplayIdentity: fails closed when environ is unreadable", async () => {
  const result = await verifyChromeDisplayIdentity({
    pid: 777,
    expectedDisplay: ":90",
    deps: {
      readEnviron: async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); },
      pidExists: () => true,
    },
  });
  assert.deepEqual(result, { ok: false, status: "owner_evidence_unavailable" });
});

test("verifyChromeDisplayIdentity: fails closed when the recorded PID is not running", async () => {
  const result = await verifyChromeDisplayIdentity({
    pid: 777,
    expectedDisplay: ":90",
    deps: { readEnviron: async () => environBuffer({ DISPLAY: ":90" }), pidExists: () => false },
  });
  assert.deepEqual(result, { ok: false, status: "missing_owner_pid" });
});

// --- real /proc integration (no injection): proves the parsing/format
// assumptions hold against this machine's actual /proc filesystem ---------

test("verifyPortOwnedByPid against real /proc: a real process is recognized as the owner of its own real listening socket", async () => {
  const server = net.createServer((socket) => socket.end());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const result = await verifyPortOwnedByPid({ port, pid: process.pid });
    assert.deepEqual(result, { ok: true, status: "owned" });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("verifyPortOwnedByPid against real /proc: a real, live, unrelated process is correctly rejected as the wrong owner", async () => {
  const server = net.createServer((socket) => socket.end());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  // A genuinely separate, real, still-alive process that never opened this
  // socket at all -- spawned (not execFile'd-and-awaited) so it is
  // definitely still running, with a real PID this test controls directly,
  // rather than guessing at an adjacent PID number.
  const { spawn } = await import("node:child_process");
  const unrelated = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"]);
  try {
    await new Promise((resolve) => setTimeout(resolve, 150));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const result = await verifyPortOwnedByPid({ port, pid: unrelated.pid });
    assert.equal(result.ok, false);
    assert.notEqual(result.status, "owned");
  } finally {
    unrelated.kill("SIGKILL");
    await new Promise((resolve) => server.close(resolve));
  }
});

// --- browserctl.mjs integration: wrong port owner is detected and does
// NOT terminate the unrelated process holding it ---------------------------

test("browserctl reports desktop_bridge_unreachable, not healthy, when the recorded websockify PID does not own the web port, and never signals the real owner", async (t) => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-desktop-port-owner-"));
  const web = net.createServer((socket) => socket.end());
  await new Promise((resolve, reject) => { web.once("error", reject); web.listen(0, "127.0.0.1", resolve); });
  const cdp = net.createServer((socket) => socket.end());
  await new Promise((resolve, reject) => { cdp.once("error", reject); cdp.listen(0, "127.0.0.1", resolve); });
  t.after(async () => {
    await Promise.all([
      new Promise((resolve) => web.close(resolve)),
      new Promise((resolve) => cdp.close(resolve)),
    ]);
    await fs.rm(home, { recursive: true, force: true });
  });
  const address = web.address();
  const webPort = typeof address === "object" && address ? address.port : 0;
  const cdpAddress = cdp.address();
  const debugPort = typeof cdpAddress === "object" && cdpAddress ? cdpAddress.port : 0;

  const stateDir = path.join(home, "browsers", "desktop");
  await fs.mkdir(stateDir, { recursive: true });
  // The web port is genuinely open (this test process holds it), but the
  // RECORDED websockifyPid is a different, unrelated live process -- it did
  // not open this socket, so it must never be reported as owning it.
  const unrelatedProcess = (await import("node:child_process")).spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"]);
  t.after(() => { unrelatedProcess.kill("SIGKILL"); });
  await new Promise((resolve) => setTimeout(resolve, 150));

  await fs.writeFile(path.join(stateDir, "desktop.json"), `${JSON.stringify({
    slug: "desktop",
    preparedAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    xvfbPid: process.pid,
    windowManagerPid: process.pid,
    x11vncPid: process.pid,
    websockifyPid: unrelatedProcess.pid,
    chromePid: process.pid,
    webPort,
    debugPort,
    vncPort: webPort,
    display: ":90",
  })}\n`);

  const { stdout } = await execFileAsync(process.execPath, [path.resolve("scripts/browserctl.mjs"), "list", "--json"], {
    env: { ...process.env, ORKESTR_HOME: home, ORKESTR_DESKTOP_VISUAL_PROBE_TIMEOUT_MS: "500" },
  });
  const session = JSON.parse(stdout).sessions.find((entry) => entry.slug === "desktop");

  assert.equal(session.readiness?.ok ?? session.ok, false);
  assert.equal((session.readiness?.issues ?? session.issues ?? []).includes("wrong_process_on_port"), true);

  // The unrelated process must still be alive: detecting the mismatch must
  // never itself signal/kill the process actually (or not actually) holding
  // the port.
  assert.equal(isAlive(unrelatedProcess.pid), true, "the unrelated process must not be terminated by readiness detection");
});

test("browserctl stop never signals a real process squatting on a recorded port -- it only ever targets the recorded PID", async (t) => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const { spawn } = await import("node:child_process");
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-desktop-port-squatter-"));
  const web = net.createServer((socket) => socket.end());
  await new Promise((resolve, reject) => { web.once("error", reject); web.listen(0, "127.0.0.1", resolve); });
  // A real, live process that happens to hold the recorded webPort, but is
  // NOT the recorded websockifyPid at all -- the "squatter" this test must
  // prove survives.
  const squatter = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"]);
  t.after(async () => {
    squatter.kill("SIGKILL");
    await new Promise((resolve) => web.close(resolve));
    await fs.rm(home, { recursive: true, force: true });
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  const address = web.address();
  const webPort = typeof address === "object" && address ? address.port : 0;

  const stateDir = path.join(home, "browsers", "desktop");
  await fs.mkdir(stateDir, { recursive: true });
  // The recorded websockifyPid is a definitely-dead PID (not the squatter);
  // browserctl's own liveness check already treats it as gone, but the
  // squatter -- discovered only as "not the owner" by the new check, never
  // as "the thing to kill" -- must never be signaled by `stop` either way.
  await fs.writeFile(path.join(stateDir, "desktop.json"), `${JSON.stringify({
    slug: "desktop",
    preparedAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    xvfbPid: 999999999,
    windowManagerPid: 999999999,
    x11vncPid: 999999999,
    websockifyPid: 999999999,
    chromePid: 999999999,
    webPort,
    debugPort: webPort,
    vncPort: webPort,
    display: ":90",
  })}\n`);

  await execFileAsync(process.execPath, [path.resolve("scripts/browserctl.mjs"), "stop", "desktop"], {
    env: { ...process.env, ORKESTR_HOME: home },
  });

  assert.equal(isAlive(squatter.pid), true, "stop must never signal a process it merely found squatting on a recorded port");
});

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}
