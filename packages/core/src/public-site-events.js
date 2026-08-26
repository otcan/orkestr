import { appendEvent } from "../../storage/src/store.js";

const allowedEvents = new Set([
  "nav_use_cases", "nav_deployment", "nav_security", "nav_developers", "sign_in_click",
  "map_workflow_header", "map_workflow_hero", "see_live_workflow", "live_workflow_view",
  "security_detail_click", "map_workflow_pilot", "map_workflow_final", "map_workflow_security",
  "map_workflow_deployment", "github_click", "docs_click", "map_workflow_use_cases",
  "workflow_form_start", "workflow_validation_error", "workflow_submit_success", "workflow_submit_error",
  "qualified_schedule_click",
]);

const allowedPaths = new Set(["/", "/use-cases", "/security", "/deployment", "/developers", "/workflow", "/beta", "/privacy", "/terms", "/acceptable-use", "/data-deletion", "/support"]);

export async function recordPublicSiteEvent(input = {}, env = process.env) {
  const event = String(input.event || "").trim().toLowerCase();
  const path = String(input.path || "").trim().split(/[?#]/)[0] || "/";
  if (!allowedEvents.has(event)) return { ok: false, ignored: true };
  if (!allowedPaths.has(path)) return { ok: false, ignored: true };
  await appendEvent({ type: "public_site_analytics", event, path }, env);
  return { ok: true };
}

export const publicSiteAnalyticsEvents = Object.freeze([...allowedEvents]);
