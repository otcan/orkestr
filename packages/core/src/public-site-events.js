import { appendEvent } from "../../storage/src/store.js";

const allowedEvents = new Set([
  "nav_use_cases", "nav_deployment", "nav_security", "nav_developers", "sign_in_click",
  "map_workflow_header", "map_workflow_hero", "see_live_workflow", "live_workflow_view",
  "security_detail_click", "map_workflow_pilot", "map_workflow_final", "map_workflow_security",
  "map_workflow_deployment", "github_click", "docs_click", "map_workflow_use_cases",
  "workflow_form_start", "workflow_validation_error", "workflow_submit_success", "workflow_submit_error",
  "qualified_schedule_click",
  "book_call_header", "book_call_mobile", "book_call_footer", "book_call_hero", "book_call_final", "see_how_it_works",
  "book_call_security", "book_call_deployment", "book_call_developers", "book_call_use_cases",
  "booking_calendar_click", "booking_email_click", "security_github_click",
  "nav_how_it_works", "book_audit_header", "book_audit_mobile", "book_audit_hero",
  "book_audit_engagement", "book_audit_final", "discuss_workflow_offer", "workflow_console_view",
  "deployment_detail_click", "security_approach_click", "client_portal_click",
  "nav_what_we_build", "nav_how_we_work", "nav_orkestr",
  "describe_project_header", "describe_project_mobile", "describe_project_hero",
  "describe_project_ugly", "describe_project_engagement", "describe_project_final",
  "see_what_we_build", "offer_build_click", "offer_replace_click", "offer_find_click",
  "offer_collect_click", "offer_automate_click", "solution_describe_project",
  "automation_audit_click", "platform_console_view",
  "project_form_start", "project_validation_error", "project_submit_success",
  "project_submit_error", "project_schedule_click",
]);

const allowedPaths = new Set(["/", "/use-cases", "/websites-commerce", "/business-systems", "/opportunity-intelligence", "/web-data-monitoring", "/automation", "/project", "/security", "/deployment", "/developers", "/workflow", "/beta", "/privacy", "/impressum", "/terms", "/acceptable-use", "/data-deletion", "/support"]);

export async function recordPublicSiteEvent(input = {}, env = process.env) {
  const event = String(input.event || "").trim().toLowerCase();
  const path = String(input.path || "").trim().split(/[?#]/)[0] || "/";
  if (!allowedEvents.has(event)) return { ok: false, ignored: true };
  if (!allowedPaths.has(path)) return { ok: false, ignored: true };
  await appendEvent({ type: "public_site_analytics", event, path }, env);
  return { ok: true };
}

export const publicSiteAnalyticsEvents = Object.freeze([...allowedEvents]);
