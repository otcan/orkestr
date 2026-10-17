import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runTenantApiAgentTool } from "../packages/core/src/tenant-api-agent-tools.js";
import { userPrincipal } from "../packages/core/src/principal.js";
import { upsertUser } from "../packages/core/src/users.js";
import { openUrlInVirtualBrowser, stopVirtualBrowser } from "../packages/browsers/src/browsers.js";

// Agent desktop skill actions (open, open_url, stop, ...) are refused while an
// owner password handoff blinds the desktop. Synthetic profile desktop only.
test("tenant agent desktop skill actions are refused on a password-blind desktop", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-pw-agent-tools-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_BROWSER_DESKTOP_MODE: "profiles",
    ORKESTR_BROWSER_VISIBLE_SLUGS: "linkedin",
    ORKESTR_BROWSER_LAUNCH_DISABLED: "1",
  };
  const principal = userPrincipal({ id: "otcan", role: "user" });
  await upsertUser({ id: "otcan", role: "user", displayName: "Otcan" }, env);
  await fs.writeFile(path.join(home, "password-handoffs.json"), JSON.stringify({ handoffs: [{
    id: "pwh_tools", ownerUserId: "otcan", threadId: "t", desktopSlug: "linkedin", targetId: "x", origin: "https://signup.example.test",
    selector: "", state: "open", startedAt: new Date().toISOString(), expiresAt: new Date(Date.now() - 1000).toISOString(),
  }] }));
  for (const [action, url] of [["open", ""], ["open_url", "https://example.test/"]]) {
    const result = await runTenantApiAgentTool("orkestr_run_skill_action", { skillId: "linkedin", action, target: "", url }, { principal }, env);
    assert.equal(result.ok, false, action);
    assert.equal(result.error, "desktop_password_blind", action);
  }
});

test("desktop lifecycle actions re-check blindness right before acting (in-flight agent actions)", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-pw-lifecycle-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const env = { ORKESTR_HOME: home, ORKESTR_BROWSER_DESKTOP_MODE: "profiles", ORKESTR_BROWSER_VISIBLE_SLUGS: "linkedin", ORKESTR_BROWSER_LAUNCH_DISABLED: "1" };
  const principal = userPrincipal({ id: "otcan", role: "user" });
  await upsertUser({ id: "otcan", role: "user", displayName: "Otcan" }, env);
  await fs.writeFile(path.join(home, "password-handoffs.json"), JSON.stringify({ handoffs: [{
    id: "pwh_life", ownerUserId: "otcan", threadId: "t", desktopSlug: "linkedin", targetId: "x", origin: "https://signup.example.test",
    selector: "", state: "open", startedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }] }));
  // An action admitted before the handoff reaches the lifecycle layer after it.
  await assert.rejects(openUrlInVirtualBrowser("linkedin", "https://example.test/", env, { principal }), /desktop_password_blind/);
  await assert.rejects(stopVirtualBrowser("linkedin", env, { principal }), /desktop_password_blind/);
  const owner = { ...principal, vaultOwner: true };
  await assert.doesNotReject(stopVirtualBrowser("linkedin", env, { principal, passwordHandoffOwner: owner }).catch((error) => {
    if (/desktop_password_blind/.test(error.message)) throw error;
  }), "the handoff owner's own session may act");
});

test("an in-flight desktop action finishes before a handoff opens; later actions are refused", async (t) => {
  const { assertDesktopNotPasswordBlind, desktopPasswordBlind, startPasswordHandoff, withDesktopHandoffGate } = await import("../packages/core/src/password-handoff.js");
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-pw-gate-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const env = { ORKESTR_HOME: home };
  const order = [];
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let admitted;
  const admittedSignal = new Promise((resolve) => { admitted = resolve; });
  // An agent action: passes its blind check, then is paused mid-action.
  const action = withDesktopHandoffGate("gate-desk", async () => {
    await assertDesktopNotPasswordBlind("gate-desk", null, env);
    admitted();
    await held;
    order.push("action_effect");
  }, env);
  await admittedSignal;
  const handoff = startPasswordHandoff(
    { kind: "user", userId: "owner", role: "admin", vaultOwner: true, recentAuthAt: new Date().toISOString() },
    { desktopSlug: "gate-desk", threadId: "pa-thread", targetId: "t", origin: "https://signup.example.test" },
    env,
    {
      activeDesktopLeaseStatus: async () => ({ active: true, threadId: "pa-thread" }),
      readManagedDesktopSession: async () => ({ cdp_url: "http://127.0.0.1:9", profileDir: "" }),
      probePasswordField: async () => ({ ok: true, field: { found: true, isPassword: true, filled: false } }),
    },
  ).then((result) => { order.push("handoff_open"); return result; });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(await desktopPasswordBlind("gate-desk", env), false, "the handoff waits for the in-flight action");
  release();
  await Promise.all([action, handoff]);
  assert.deepEqual(order, ["action_effect", "handoff_open"]);
  await assert.rejects(withDesktopHandoffGate("gate-desk", () => assertDesktopNotPasswordBlind("gate-desk", null, env), env), /desktop_password_blind/, "actions after the start are refused");
});

test("start re-validates the tab under the gate; the operator gates the desktop it resolves from args", async (t) => {
  const { startPasswordHandoff, withDesktopHandoffGate } = await import("../packages/core/src/password-handoff.js");
  const { operateManagedDesktop } = await import("../packages/browsers/src/desktop-operator.js");
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-pw-gate2-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const env = { ORKESTR_HOME: home };
  // The page changes inside an in-flight action; the start's probe must see the change.
  let filled = false;
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let admitted;
  const admittedSignal = new Promise((resolve) => { admitted = resolve; });
  const action = withDesktopHandoffGate("gate-desk", async () => { admitted(); await held; filled = true; }, env);
  await admittedSignal;
  const start = startPasswordHandoff(
    { kind: "user", userId: "owner", role: "admin", vaultOwner: true, recentAuthAt: new Date().toISOString() },
    { desktopSlug: "gate-desk", threadId: "pa-thread", targetId: "t", origin: "https://signup.example.test" },
    env,
    {
      activeDesktopLeaseStatus: async () => ({ active: true, threadId: "pa-thread" }),
      readManagedDesktopSession: async () => ({ cdp_url: "http://127.0.0.1:9", profileDir: "" }),
      probePasswordField: async () => ({ ok: true, field: { found: true, isPassword: true, filled } }),
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  release();
  await action;
  await assert.rejects(start, /password_handoff_field_not_empty/, "the probe runs after the in-flight action, under the gate");

  // operateManagedDesktop("", { slug }) waits on the same gate as that desktop.
  let opReleased = false;
  let releaseGate;
  const gateHeld = new Promise((resolve) => { releaseGate = resolve; });
  let gateAdmitted;
  const gateAdmittedSignal = new Promise((resolve) => { gateAdmitted = resolve; });
  const holder = withDesktopHandoffGate("args-desk", async () => { gateAdmitted(); await gateHeld; opReleased = true; }, env);
  await gateAdmittedSignal;
  const op = operateManagedDesktop("", { slug: "args-desk", operation: "observe" }, env).then(() => opReleased, () => opReleased);
  await new Promise((resolve) => setTimeout(resolve, 100));
  releaseGate();
  await holder;
  assert.equal(await op, true, "the operation ran only after the holder released the args-desk gate");
});
