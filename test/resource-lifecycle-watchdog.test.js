import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyDesktop,
  evaluateDesktopPolicy,
  lifecycleConfig,
  lifecycleHealth,
  observeOrphanRuntime,
  parseDurationMs,
  trackTabsAndPlan,
} from "../scripts/resource-lifecycle-watchdog.mjs";

test("resource lifecycle parses explicit duration units", () => {
  assert.equal(parseDurationMs("5m", 1), 300_000);
  assert.equal(parseDurationMs("2h", 1), 7_200_000);
  assert.equal(parseDurationMs("invalid", 123), 123);
});

test("resource lifecycle separates desktop VMs from host browser desktops", () => {
  const config = lifecycleConfig({ ORKESTR_RESOURCE_LIFECYCLE_DESKTOP_VMS: "wa-windows" });
  assert.equal(classifyDesktop({ slug: "wa-windows", type: "desktop" }, config), "desktop_vm");
  assert.equal(classifyDesktop({ slug: "linkedin", type: "desktop", managed: true }, config), "host_browser_desktop");
  assert.equal(classifyDesktop({ slug: "whatsapp-bridge", type: "service" }, config), "service_browser");
});

test("tab cleanup preserves active and protected pages and only closes aged background tabs", () => {
  const nowMs = Date.parse("2026-08-06T08:00:00.000Z");
  const first = trackTabsAndPlan({}, [
    { id: "active", type: "page", url: "https://example.test/active", activityKnown: true, active: true },
    { id: "feed", type: "page", url: "https://www.linkedin.com/feed/", activityKnown: true, active: false },
    { id: "old-1", type: "page", url: "https://example.test/1", activityKnown: true, active: false },
    { id: "old-2", type: "page", url: "https://example.test/2", activityKnown: true, active: false },
  ], { nowMs: nowMs - 4 * 3_600_000, maxAgeMs: 2 * 3_600_000, protectedUrlPatterns: ["linkedin\\.com/feed"] });
  const planned = trackTabsAndPlan(first.tracked, [
    { id: "active", type: "page", url: "https://example.test/active", activityKnown: true, active: true },
    { id: "feed", type: "page", url: "https://www.linkedin.com/feed/", activityKnown: true, active: false },
    { id: "old-1", type: "page", url: "https://example.test/1", activityKnown: true, active: false },
    { id: "old-2", type: "page", url: "https://example.test/2", activityKnown: true, active: false },
  ], {
    nowMs,
    maxAgeMs: 2 * 3_600_000,
    maxCount: 8,
    minKeep: 2,
    maxClose: 3,
    protectedUrlPatterns: ["linkedin\\.com/feed"],
  });
  assert.deepEqual(planned.closeIds.sort(), ["old-1", "old-2"]);
  assert.equal(planned.closeIds.includes("active"), false);
  assert.equal(planned.closeIds.includes("feed"), false);
});

test("desktop policy protects leases and expires only configured transient desktops", () => {
  const config = lifecycleConfig({
    ORKESTR_RESOURCE_LIFECYCLE_TRANSIENT_DESKTOPS: "wa-windows",
    ORKESTR_RESOURCE_LIFECYCLE_DESKTOP_IDLE_STOP: "30m",
  });
  const nowMs = Date.parse("2026-08-06T08:00:00.000Z");
  const prior = { lastInteractiveAt: "2026-08-06T07:00:00.000Z" };
  const protectedResult = evaluateDesktopPolicy({
    nowMs,
    prior,
    session: { slug: "wa-windows", type: "desktop", status: "active" },
    leaseActive: true,
  }, config);
  const expired = evaluateDesktopPolicy({
    nowMs,
    prior,
    session: { slug: "wa-windows", type: "desktop", status: "active" },
  }, config);
  assert.equal(protectedResult.action, "none");
  assert.equal(expired.action, "stop");
});

test("desktop restart policy requires a prior observation", () => {
  const config = lifecycleConfig({
    ORKESTR_RESOURCE_LIFECYCLE_BROWSER_RESTART_UPTIME: "1h",
  });
  const nowMs = Date.parse("2026-08-06T10:00:00.000Z");
  const input = {
    nowMs,
    session: { slug: "linkedin", type: "desktop", status: "active" },
    resourceClass: "host_browser_desktop",
    leaseActive: false,
    connectionActive: false,
    uptimeMs: 2 * 3_600_000,
  };

  assert.equal(evaluateDesktopPolicy({ ...input, prior: {} }, config).action, "none");
  assert.equal(evaluateDesktopPolicy({
    ...input,
    prior: { firstObservedAt: "2026-08-06T09:55:00.000Z" },
  }, config).action, "restart");
});

test("orphan policy protects reachable full instances and requires repeated unreachable observations", () => {
  const config = lifecycleConfig({
    ORKESTR_RESOURCE_LIFECYCLE_ORPHAN_CLEANUP_ENABLED: "1",
    ORKESTR_RESOURCE_LIFECYCLE_ORPHAN_GRACE: "10m",
    ORKESTR_RESOURCE_LIFECYCLE_ORPHAN_MIN_OBSERVATIONS: "3",
  });
  const runtime = { id: "sandbox-1", namespace: "tenants", name: "virt-launcher-alice", vmName: "alice" };
  const start = Date.parse("2026-08-06T08:00:00.000Z");
  const reachable = observeOrphanRuntime({}, runtime, { nowMs: start, apiResourceExists: false, instanceReachable: true }, config);
  assert.equal(reachable.action, "none");
  assert.equal(reachable.reason, "reachable_instance_protected");
  const first = observeOrphanRuntime({}, runtime, { nowMs: start, apiResourceExists: false, instanceReachable: false }, config);
  const second = observeOrphanRuntime(first, runtime, { nowMs: start + 5 * 60_000, apiResourceExists: false, instanceReachable: false }, config);
  const third = observeOrphanRuntime(second, runtime, { nowMs: start + 10 * 60_000, apiResourceExists: false, instanceReachable: false }, config);
  assert.equal(second.action, "none");
  assert.equal(third.action, "cleanup");
});

test("health watchdog fails closed for missing, failed, and stale runs", () => {
  const nowMs = Date.parse("2026-08-06T08:00:00.000Z");
  assert.equal(lifecycleHealth({}, nowMs, 10 * 60_000).reason, "never_succeeded");
  assert.equal(lifecycleHealth({ lastSuccessAt: "2026-08-06T07:00:00.000Z" }, nowMs, 10 * 60_000).reason, "heartbeat_stale");
  assert.equal(lifecycleHealth({ lastSuccessAt: "2026-08-06T07:59:00.000Z", lastRun: { ok: false } }, nowMs, 10 * 60_000).reason, "last_run_failed");
  assert.equal(lifecycleHealth({ lastSuccessAt: "2026-08-06T07:59:00.000Z", lastRun: { ok: true } }, nowMs, 10 * 60_000).ok, true);
});
