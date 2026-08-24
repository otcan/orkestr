import { resolveTargetInstance, targetResolutionMetadata } from "./target-resolver.js";

function clean(value = "") {
  return String(value || "").trim();
}

function lower(value = "") {
  return clean(value).toLowerCase();
}

function truthy(value) {
  return value === true || ["1", "true", "yes", "on"].includes(lower(value));
}

function principalUserId(principal = {}) {
  return clean(principal.userId || principal.id || "admin") || "admin";
}

function desktopEligible(desktop = {}) {
  const status = lower(desktop.status || desktop.state);
  return !["deleted", "deleting", "disabled", "suspended", "stopped", "inactive", "unknown"].includes(status);
}

function desktopCandidates(desktops = [], principal = {}) {
  const ownerUserId = principalUserId(principal);
  return (Array.isArray(desktops) ? desktops : []).map((desktop) => {
    const slug = clean(desktop.slug || desktop.id);
    const eligible = Boolean(slug) && desktopEligible(desktop);
    return {
      id: slug,
      type: "desktop",
      ownerUserId: clean(desktop.ownerUserId) || ownerUserId,
      status: clean(desktop.status || desktop.state || "unknown"),
      eligible,
      reason: eligible ? "eligible" : "desktop_not_available",
      resource: desktop,
    };
  }).filter((candidate) => candidate.id);
}

function semanticallyMatchesRequiredDesktop(candidate = {}, requiredDesktop = "", skill = {}) {
  const required = lower(requiredDesktop);
  if (!required) return true;
  const resource = candidate.resource || {};
  const connector = lower(resource.connector);
  const type = lower(resource.type);
  const purpose = lower(resource.purpose || resource.notes);
  const label = lower(resource.label || resource.displayName);
  const startUrl = lower(resource.startUrl || resource.url);
  if (candidate.id === required) return true;
  if (connector === required || type === required || purpose === required) return true;
  if (lower(skill.id) === required && connector === lower(skill.id)) return true;
  if (required === "linkedin") return connector === "linkedin" || /\blinkedin\b/.test(`${purpose} ${label} ${startUrl}`);
  return false;
}

export async function resolveSkillDesktopTarget({
  skill = {},
  desktops = [],
  env = process.env,
  args = {},
  principal = {},
  threadId = "",
  action = "skill.desktop.resolve",
} = {}) {
  const explicitArg = clean(args.target || args.slug);
  const requiredDesktop = clean(skill.requiredDesktop || skill.requiresDesktop);
  const linkedinDesktop = lower(skill.id) === "linkedin"
    ? clean(env.ORKESTR_LINKEDIN_DESKTOP_SLUG || env.ORKESTR_LINKEDIN_BROWSER_SLUG)
    : "";
  const candidates = desktopCandidates(desktops, principal);
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  const genericConfiguredDesktop = requiredDesktop ? "" : [env.ORKESTR_DEFAULT_DESKTOP_SLUG, env.ORKESTR_MANUAL_INTERVENTION_DESKTOP_SLUG]
    .map(clean)
    .find((slug) => slug && candidateIds.has(slug)) || "";
  const exactRequired = requiredDesktop && candidateIds.has(requiredDesktop) ? requiredDesktop : "";
  const semanticCandidates = requiredDesktop
    ? candidates.filter((candidate) => candidate.eligible && semanticallyMatchesRequiredDesktop(candidate, requiredDesktop, skill))
    : [];
  const semanticSingle = requiredDesktop && !explicitArg && !linkedinDesktop && !exactRequired && semanticCandidates.length === 1
    ? semanticCandidates[0].id
    : "";
  const explicitTargetId = explicitArg || linkedinDesktop || exactRequired || semanticSingle || genericConfiguredDesktop;
  const resolution = await resolveTargetInstance({
    targetType: "desktop",
    explicitTargetId,
    ownerUserId: principalUserId(principal),
    principal,
    threadId,
    operation: args.operation,
    dryRun: truthy(args.dryRun) || truthy(args.dry_run),
    preflight: truthy(args.preflight),
    action,
    candidates,
    allowSingleInference: !requiredDesktop,
    selectionSource: explicitArg
      ? "explicit_request"
      : explicitTargetId
        ? semanticSingle
          ? "single_semantic_target"
          : "skill_configured_desktop"
        : "single_authorized_target",
  }, env);
  return {
    ok: resolution.ok === true,
    error: resolution.error || "",
    statusCode: resolution.statusCode || 200,
    desktop: resolution.selectedTarget?.resource || null,
    slug: clean(resolution.selectedTarget?.id),
    targetSelection: targetResolutionMetadata(resolution),
    candidates: resolution.candidates || [],
  };
}
