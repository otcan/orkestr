import assert from "node:assert/strict";
import test from "node:test";
import { nativeTerminalLaunchSpec, shellQuote } from "../packages/core/src/native-terminal.js";

test("native terminal launch spec supports configured launchers", () => {
  const spec = nativeTerminalLaunchSpec(
    "codex resume abc",
    { cwd: "/tmp/orkestr repo", title: "Orkestr Thread" },
    { ORKESTR_NATIVE_TERMINAL_COMMAND: "my-terminal --title {title} --cwd {cwd} -- {command}" },
    "linux",
  );

  assert.equal(spec.command, "sh");
  assert.equal(spec.launcher, "configured");
  assert.deepEqual(spec.args, [
    "-lc",
    "my-terminal --title 'Orkestr Thread' --cwd '/tmp/orkestr repo' -- 'codex resume abc'",
  ]);
  assert.equal(spec.cwd, "/tmp/orkestr repo");
});

test("native terminal launch spec uses platform defaults", () => {
  assert.equal(shellQuote("it's ok"), "'it'\\''s ok'");

  const mac = nativeTerminalLaunchSpec("orkestr attach test", { cwd: "/tmp/app" }, {}, "darwin");
  assert.equal(mac.command, "osascript");
  assert.equal(mac.launcher, "terminal.app");
  assert.ok(mac.args.join(" ").includes("Terminal"));

  const linux = nativeTerminalLaunchSpec("orkestr attach test", { title: "Thread" }, {}, "linux");
  assert.equal(linux.command, "sh");
  assert.equal(linux.launcher, "linux-terminal");
  assert.ok(linux.args.join(" ").includes("x-terminal-emulator"));

  const win = nativeTerminalLaunchSpec("orkestr attach test", { title: "Thread" }, {}, "win32");
  assert.equal(win.command, "cmd.exe");
  assert.equal(win.launcher, "cmd");
});
