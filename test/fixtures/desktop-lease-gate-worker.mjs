import fs from "node:fs";
import { spawn } from "node:child_process";
import { DesktopLeaseStore } from "../../packages/browsers/src/desktop-lease-store.js";

const [file, mode, signalFile, optionsFile] = process.argv.slice(2);
const options = optionsFile ? JSON.parse(fs.readFileSync(optionsFile, "utf8")) : {};
const store = new DesktopLeaseStore(file, { lockTimeoutMs: options.timeoutMs || 200 });
let unrelated;
try {
  let result;
  if (mode === "legacy-hold") {
    fs.mkdirSync(`${file}.lock`);
    try {
      fs.writeFileSync(`${file}.lock/owner.json`, JSON.stringify({ pid: process.pid }));
      fs.writeFileSync(signalFile, JSON.stringify({ pid: process.pid }));
      process.kill(process.pid, "SIGSTOP");
      result = { legacyHolder: true };
    } finally {
      fs.rmSync(`${file}.lock`, { recursive: true });
    }
  } else if (mode === "hold" || mode === "hold-with-child") {
    result = await store.mutateState((state) => {
      unrelated = mode === "hold-with-child"
        ? spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }) : null;
      fs.writeFileSync(signalFile, JSON.stringify({ pid: process.pid, child: unrelated?.pid || null }));
      process.kill(process.pid, "SIGSTOP");
      state.desktopLeases[0].purpose = "holder-finished";
      return { finished: true };
    });
  } else if (mode === "action") {
    result = await store.withCurrentLeaseAction(options.binding, () => {
      fs.writeFileSync(signalFile, JSON.stringify({ pid: process.pid }));
      if (options.pause) process.kill(process.pid, "SIGSTOP");
      fs.appendFileSync(options.effect, "action\n");
      return "done";
    });
  } else if (mode === "init") {
    await store.init();
    result = { initialized: true };
  } else if (mode === "release") {
    result = await store.release("synthetic-desk", { ownerUserId: "synthetic-owner", threadId: "thread-a" });
  } else if (mode === "heartbeat") {
    result = await store.heartbeat("synthetic-desk", "thread-a", "synthetic-owner");
  } else if (mode === "acquire") {
    result = await store.acquire({ desktopSlug: options.desktopSlug || "synthetic-desk", ownerUserId: "synthetic-owner",
      threadId: options.threadId || "thread-b", expiresAt: new Date(Date.now() + 60_000).toISOString() }, { force: true });
  } else {
    throw new Error("invalid_fixture_operation");
  }
  console.log(JSON.stringify({ ok: true, result }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: error.message, statusCode: error.statusCode }));
} finally {
  if (unrelated) {
    const exited = new Promise((resolve) => unrelated.once("exit", resolve));
    unrelated.kill("SIGKILL");
    await exited;
  }
}
