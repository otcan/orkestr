// Supervises the `node --test` child for scripts/ci-test-runner.mjs:
// collects output, tracks per-file progress markers, enforces an overall
// watchdog, and resolves on child exit plus a short stdio grace so a leaked
// grandchild holding the pipes cannot hang the runner forever.
import { spawn } from "node:child_process";
import { progressMarker } from "./ci-test-progress-reporter.mjs";

const groupKillSupported = process.platform !== "win32";

function killTree(child, signal) {
  if (!child.pid) return;
  try {
    if (groupKillSupported) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // Already gone.
  }
}

function lineSplitter(onLine) {
  let pending = "";
  return {
    push(chunk) {
      pending += chunk.toString("utf8");
      const lines = pending.split("\n");
      pending = lines.pop();
      for (const line of lines) onLine(line);
    },
    flush() {
      if (pending) onLine(pending);
      pending = "";
    },
  };
}

function formatSeconds(ms) {
  return `${Math.round(ms / 1000)}s`;
}

export function createProgressTracker({ totalFiles = 0, now = Date.now } = {}) {
  const startedAt = now();
  const running = new Map();
  const started = [];
  let done = 0;
  let failed = 0;
  let lastActivityAt = startedAt;
  return {
    apply(event = {}) {
      if (!event.file) return null;
      lastActivityAt = now();
      if (event.type === "start") {
        running.set(event.file, lastActivityAt);
        started.push(event.file);
        return null;
      }
      if (event.type !== "done") return null;
      running.delete(event.file);
      done += 1;
      if (!event.passed) failed += 1;
      return event;
    },
    snapshot() {
      return {
        done,
        failed,
        totalFiles,
        elapsedMs: now() - startedAt,
        idleMs: now() - lastActivityAt,
        running: [...running.entries()].map(([file, since]) => ({ file, forMs: now() - since })),
        lastStarted: started.slice(-10),
      };
    },
    describe(prefix = "[ci-test]") {
      const snap = this.snapshot();
      const running = snap.running.map((item) => `${item.file} (${formatSeconds(item.forMs)})`).join(", ") || "none";
      return `${prefix} ${snap.done}/${snap.totalFiles} files done, ${snap.failed} failed, ` +
        `elapsed ${formatSeconds(snap.elapsedMs)}; running: ${running}`;
    },
  };
}

export function runTestChild({
  execPath = process.execPath,
  args = [],
  cwd = process.cwd(),
  env = process.env,
  totalFiles = 0,
  watchdogMs = 0,
  stdioGraceMs = 5_000,
  killGraceMs = 5_000,
  progressEvery = 0,
  heartbeatMs = 0,
  log = (line) => console.log(line),
} = {}) {
  const child = spawn(execPath, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    // Own process group so the watchdog can kill node --test and every test
    // file subprocess it spawned, not just the top-level runner.
    detached: groupKillSupported,
  });
  const chunks = [];
  const tracker = createProgressTracker({ totalFiles });
  const timers = [];
  let timedOut = false;
  let stdioTimedOut = false;

  const stderrLines = lineSplitter((line) => {
    if (!line.startsWith(progressMarker)) {
      chunks.push(Buffer.from(`${line}\n`));
      return;
    }
    let event = null;
    try {
      event = JSON.parse(line.slice(progressMarker.length));
    } catch {
      return;
    }
    const finished = tracker.apply(event);
    if (finished && progressEvery > 0) {
      const { done } = tracker.snapshot();
      if (done % progressEvery === 0 || done === totalFiles || !finished.passed) {
        log(tracker.describe(finished.passed ? "[ci-test]" : `[ci-test] FAIL ${finished.file};`));
      }
    }
  });
  child.stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderrLines.push(chunk));

  const forwardSignal = (signal) => {
    killTree(child, signal);
    process.exitCode = 130;
  };
  const onSigint = () => forwardSignal("SIGINT");
  const onSigterm = () => forwardSignal("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  if (heartbeatMs > 0) {
    const heartbeat = setInterval(() => log(tracker.describe("[ci-test] heartbeat:")), heartbeatMs);
    heartbeat.unref();
    timers.push(heartbeat);
  }
  if (watchdogMs > 0) {
    const watchdog = setTimeout(() => {
      timedOut = true;
      killTree(child, "SIGTERM");
      const hardKill = setTimeout(() => killTree(child, "SIGKILL"), killGraceMs);
      hardKill.unref();
      timers.push(hardKill);
    }, watchdogMs);
    watchdog.unref();
    timers.push(watchdog);
  }

  return new Promise((resolve) => {
    let exitCode = null;
    let exitSignal = null;
    let settled = false;
    function finish() {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      stderrLines.flush();
      resolve({
        exitCode,
        exitSignal,
        timedOut,
        stdioTimedOut,
        output: Buffer.concat(chunks).toString("utf8"),
        progress: tracker.snapshot(),
      });
    }
    child.on("error", (error) => {
      chunks.push(Buffer.from(`${error.stack || error.message}\n`));
      exitCode = exitCode ?? 1;
      finish();
    });
    child.on("exit", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      // 'close' waits for every holder of the pipes. A leaked grandchild can
      // keep them open forever, so give stdio a short grace, then clean up the
      // rest of the process group and resolve with what was collected.
      const grace = setTimeout(() => {
        stdioTimedOut = true;
        killTree(child, "SIGKILL");
        child.stdout.destroy();
        child.stderr.destroy();
        finish();
      }, stdioGraceMs);
      grace.unref();
      timers.push(grace);
    });
    child.on("close", finish);
  });
}
