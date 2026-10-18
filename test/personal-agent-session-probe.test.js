import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { probeInstalledSessions } from "../scripts/personal-agent-session-probe.mjs";

for (const configuredWrapper of [true, false]) {
  test(`inventory never executes a Claude ${configuredWrapper ? "configured wrapper" : "PATH fallback"} or touches its ambient profile`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-probe-fixture-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const calls = path.join(root, "calls.jsonl");
    const profile = path.join(root, "synthetic-profile");
    await fs.mkdir(profile);
    const marker = path.join(profile, "wrapper-side-effect");
    const bin = path.join(root, "claude");
    // Synthetic stand-in for a wrapper with side effects even on --version.
    await fs.writeFile(bin, `#!${process.execPath}\n` +
      `const fs = require("node:fs");\n` +
      `fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n` +
      `fs.writeFileSync(${JSON.stringify(marker)}, "synthetic side effect");\n` +
      `console.log(process.argv[2] === "auth" ? JSON.stringify({authMethod:"subscription_token",loggedIn:true}) : "2.1.295 --resume --fork-session --session-id --model --effort --output-format");\n`, { mode: 0o755 });
    const result = await probeInstalledSessions({
      PATH: root,
      HOME: root,
      ORKESTR_CODEX_BIN: path.join(root, "missing-codex"),
      ...(configuredWrapper ? { ORKESTR_CLAUDE_CODE_BIN: bin } : {}),
      CLAUDE_CONFIG_DIR: profile,
    });
    const observed = (await fs.readFile(calls, "utf8").catch(() => "")).trim();
    assert.equal(observed, "", "metadata inventory must never dispatch a profile-aware Claude command");
    assert.equal(await fs.stat(marker).then(() => true, () => false), false, "profile left untouched");
    assert.equal(result.claude.blocked, "manual_metadata_verification_required");
    assert.deepEqual(result.claude.auth, { verified: false });
    assert.equal(result.inferenceTurns, 0);
  });
}
