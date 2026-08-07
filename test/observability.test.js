import assert from "node:assert/strict";
import test from "node:test";
import {
  metricsRequestAllowed,
  recordBackgroundLoopMetrics,
  recordMailboxThreadDeliveryMetrics,
  recordTaskAgentLifecycleMetric,
  recordThreadResourceAccessMetric,
  recordThreadResourceBreakGlassMetric,
  recordThreadResourceInvalidationMetric,
  recordWatcherAlertMetric,
  recordWhatsAppDeliveryMetrics,
  renderOpenMetrics,
  resetObservabilityForTests,
  routeTemplateFromUrl,
} from "../packages/core/src/observability.js";

test("observability route templates scrub dynamic IDs", () => {
  assert.equal(routeTemplateFromUrl("/api/threads/thread-123/messages"), "/api/threads/:threadId/messages");
  assert.equal(routeTemplateFromUrl("/api/browser-sessions/linkedin/prepare"), "/api/browser-sessions/:desktopSlug/prepare");
  assert.equal(
    routeTemplateFromUrl("/api/shared-apps/i/tenant-123/a/app-456/s/share-secret/messages"),
    "/api/shared-apps/i/:id/a/:id/s/:id/messages",
  );
  assert.equal(
    routeTemplateFromUrl("/api/connectors/whatsapp/accounts/sender/status"),
    "/api/connectors/whatsapp/accounts/:accountId/status",
  );
  assert.equal(routeTemplateFromUrl("/api/desktops/private-desk/acquire"), "/api/desktops/:desktopSlug/acquire");
  assert.equal(routeTemplateFromUrl("/desktop/private-desk/vnc.html"), "/desktop/:desktopSlug/vnc.html");
  assert.equal(
    routeTemplateFromUrl("/api/tenant-vms/tenant-vm-123/desktop-shares/desk-share-456/status"),
    "/api/tenant-vms/:tenantVmId/desktop-shares/:shareId/status",
  );
});

test("metrics endpoint defaults to local-only unless public or token auth is configured", () => {
  const localRequest = { headers: { host: "127.0.0.1:19812" }, socket: { remoteAddress: "::ffff:127.0.0.1" } };
  const remoteRequest = { headers: { host: "app.example.test" }, socket: { remoteAddress: "203.0.113.10" } };
  const remoteTokenRequest = {
    headers: { host: "app.example.test", authorization: "Bearer scrape-token" },
    socket: { remoteAddress: "203.0.113.10" },
  };

  assert.deepEqual(metricsRequestAllowed(localRequest, {}), { ok: true });
  assert.deepEqual(metricsRequestAllowed(remoteRequest, {}), { ok: false, statusCode: 403, error: "metrics_local_only" });
  assert.deepEqual(metricsRequestAllowed(remoteRequest, { ORKESTR_METRICS_PUBLIC: "1" }), { ok: true });
  assert.deepEqual(
    metricsRequestAllowed(remoteRequest, { ORKESTR_METRICS_TOKEN: "scrape-token" }),
    { ok: false, statusCode: 401, error: "metrics_token_required" },
  );
  assert.deepEqual(metricsRequestAllowed(remoteTokenRequest, { ORKESTR_METRICS_TOKEN: "scrape-token" }), { ok: true });
  assert.deepEqual(metricsRequestAllowed(localRequest, { ORKESTR_METRICS_ENABLED: "0" }), {
    ok: false,
    statusCode: 404,
    error: "metrics_disabled",
  });
});

test("observability records loop, delivery, task-agent, and watcher counters", () => {
  resetObservabilityForTests();

  recordBackgroundLoopMetrics({
    loop: "runtime_sync",
    result: "completed",
    durationMs: 42,
    counts: { recovered_pending_inputs: 2 },
  });
  recordWhatsAppDeliveryMetrics({
    source: "delivery_scheduler",
    result: { sent: [{}, {}], failed: [{}], skipped: [{}] },
    durationMs: 125,
  });
  recordTaskAgentLifecycleMetric("result_completed", "completed");
  recordWatcherAlertMetric({ source: "server.runtimeMonitor", code: "runtime_sync_failed", severity: "error" });
  recordThreadResourceAccessMetric({ resourceType: "mailbox", permission: "subscribe", mode: "shadow", shadowDenied: true, durationMs: 12 });
  recordThreadResourceInvalidationMetric({ resourceType: "desktop", subject: "share", reason: "Message-ID <person@example.test>" });
  recordMailboxThreadDeliveryMetrics({ state: "dead-letter", lagMs: 1_000 });
  recordThreadResourceBreakGlassMetric({ resourceType: "oxrm", outcome: "allowed" });
  recordThreadResourceAccessMetric({ resourceType: "resource-private-id", permission: "Message-ID <person@example.test>", mode: "untrusted-mode" });

  const metrics = renderOpenMetrics();
  assert.match(metrics, /orkestr_background_loop_runs_total\{loop="runtime_sync",result="completed"\} 1/);
  assert.match(metrics, /orkestr_background_loop_items_total\{loop="runtime_sync",item="recovered_pending_inputs"\} 2/);
  assert.match(metrics, /orkestr_whatsapp_delivery_runs_total\{source="delivery_scheduler",result="partial_failure"\} 1/);
  assert.match(metrics, /orkestr_whatsapp_delivery_messages_total\{source="delivery_scheduler",state="sent"\} 2/);
  assert.match(metrics, /orkestr_task_agent_lifecycle_total\{event="result_completed",status="completed"\} 1/);
  assert.match(metrics, /orkestr_watcher_alerts_total\{source="server.runtimemonitor",code="runtime_sync_failed",severity="error"\} 1/);
  assert.match(metrics, /orkestr_thread_resource_access_decisions_total\{resource_type="mailbox",permission="subscribe",mode="shadow",outcome="shadow_denied"\} 1/);
  assert.match(metrics, /orkestr_thread_resource_shadow_mismatches_total\{resource_type="mailbox",permission="subscribe"\} 1/);
  assert.match(metrics, /orkestr_thread_resource_invalidations_total\{resource_type="desktop",subject="share",reason="unknown"\} 1/);
  assert.equal(metrics.includes("person@example.test"), false);
  assert.match(metrics, /orkestr_mailbox_thread_delivery_transitions_total\{state="dead-letter"\} 1/);
  assert.match(metrics, /orkestr_thread_resource_break_glass_total\{resource_type="oxrm",outcome="allowed"\} 1/);
  assert.equal(metrics.includes("resource-private-id"), false);
});
