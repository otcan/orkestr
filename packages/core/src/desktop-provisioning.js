function clean(value = "") {
  return String(value || "").trim();
}

function lower(value = "") {
  return clean(value).toLowerCase();
}

function boolEnv(value, fallback = null) {
  const normalized = lower(value);
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on", "enabled"].includes(normalized)) return true;
  if (["0", "false", "no", "off", "disabled"].includes(normalized)) return false;
  return fallback;
}

function stringList(values = []) {
  const list = Array.isArray(values) ? values : String(values || "").split(/[\s,]+/g);
  return [...new Set(list.map(clean).filter(Boolean))];
}

function visibleDesktopSlugs(env = process.env, tenantVm = null) {
  const envSlugs = stringList(env.ORKESTR_BROWSER_VISIBLE_SLUGS || env.ORKESTR_OPS_DESKTOP_SLUGS);
  if (envSlugs.length) return new Set(envSlugs);
  const desktopSlugs = stringList(tenantVm?.desktops?.visibleSlugs || tenantVm?.desktops?.slugs);
  if (desktopSlugs.length) return new Set(desktopSlugs);
  const bootstrapSlugs = stringList(tenantVm?.bootstrap?.desks);
  if (bootstrapSlugs.length) return new Set(bootstrapSlugs);
  return null;
}

function desktopFallbackSlugs(env = process.env, tenantVm = null) {
  return [
    clean(env.ORKESTR_LINKEDIN_DESKTOP_SLUG || env.ORKESTR_LINKEDIN_BROWSER_SLUG),
    clean(tenantVm?.connectors?.linkedinDesktopSlug),
    clean(tenantVm?.desktops?.defaultSlug),
    clean(env.ORKESTR_DEFAULT_DESKTOP_SLUG),
    clean(env.ORKESTR_MANUAL_INTERVENTION_DESKTOP_SLUG),
    "desktop",
  ].filter(Boolean);
}

function requiredDesktopAllowed(skillId = "", env = process.env, tenantVm = null) {
  const visible = visibleDesktopSlugs(env, tenantVm);
  if (!visible) return true;
  const id = lower(skillId);
  const candidates = id === "linkedin"
    ? ["linkedin", ...desktopFallbackSlugs(env, tenantVm)]
    : [id];
  return candidates.some((slug) => visible.has(slug));
}

function explicitManagedBackend(env = process.env) {
  return Boolean(clean(env.ORKESTR_BROWSERCTL_PATH || env.ORKESTR_BROWSERCTL || env.ORKESTR_BROWSER_API_URL || env.ORKESTR_BROWSER_SESSIONS_URL));
}

function tenantDesktopHint(tenantVm = null) {
  if (!tenantVm) {
    return {
      hasDesktopCapability: false,
      userProvisioned: null,
      unhealthy: false,
      status: "",
    };
  }
  const capabilities = new Set(stringList(tenantVm.capabilities).map(lower));
  const desktopStatus = lower(tenantVm.desktops?.status);
  const vmStatus = lower(tenantVm.status);
  const provisioned = tenantVm.desktops?.provisioned;
  const enabled = tenantVm.desktops?.enabled;
  const hasDesktopCapability = Boolean(
    capabilities.has("desks") ||
    capabilities.has("desktop") ||
    capabilities.has("linkedin") ||
    clean(tenantVm.connectors?.linkedinDesktopSlug) ||
    stringList(tenantVm.bootstrap?.desks).length ||
    stringList(tenantVm.desktops?.visibleSlugs || tenantVm.desktops?.slugs).length
  );
  const unhealthy = ["error", "unhealthy"].includes(desktopStatus) || vmStatus === "error";
  const readyStatus = ["ready", "running", "available", "provisioned"].includes(desktopStatus);
  const userProvisioned = enabled === false
    ? false
    : provisioned === true || readyStatus || (hasDesktopCapability && vmStatus === "running");
  return {
    hasDesktopCapability,
    userProvisioned,
    unhealthy,
    status: desktopStatus || vmStatus,
  };
}

export function desktopProvisioningMessage(setupState = "") {
  const state = clean(setupState);
  if (state === "instance_desktops_disabled") {
    return "Managed Desktop is disabled for this Orkestr instance.";
  }
  if (state === "instance_desktops_not_provisioned") {
    return "Managed Desktop is not provisioned for this Orkestr instance yet.";
  }
  if (state === "user_desktop_not_provisioned") {
    return "Managed Desktop is enabled for this Orkestr instance, but no desktop has been provisioned for this user yet.";
  }
  if (state === "desktop_backend_unhealthy") {
    return "Managed Desktop is provisioned, but the desktop backend is currently unavailable.";
  }
  if (state === "skill_disabled") return "Managed Desktop is disabled for this chat.";
  return "Managed Desktop is not available for this chat.";
}

export function resolveDesktopProvisioningState({ skillId = "linkedin", userFound = true, tenantVm = null, env = process.env } = {}) {
  const mode = lower(env.ORKESTR_BROWSER_DESKTOP_MODE);
  const userDesktopsEnabled = boolEnv(env.ORKESTR_USER_DESKTOPS_ENABLED, null);
  const instanceProvisioned = boolEnv(env.ORKESTR_INSTANCE_DESKTOPS_PROVISIONED, null);
  const launchDisabled = clean(env.ORKESTR_BROWSER_LAUNCH_DISABLED) === "1";
  const backendStatus = lower(env.ORKESTR_DESKTOP_BACKEND_STATUS || env.ORKESTR_BROWSER_BACKEND_STATUS);
  const hasManagedBackend = explicitManagedBackend(env);
  const tenantHint = tenantDesktopHint(tenantVm);
  const profilesExplicit = mode === "profiles";
  const browserctlExplicit = mode === "browserctl";
  const backendConfigured = hasManagedBackend || profilesExplicit || browserctlExplicit || tenantHint.hasDesktopCapability;

  let setupState = "available";
  if (!userFound) setupState = "user_desktop_not_provisioned";
  else if (["disabled", "none", "off"].includes(mode)) setupState = "instance_desktops_disabled";
  else if (userDesktopsEnabled === false) setupState = "instance_desktops_not_provisioned";
  else if (instanceProvisioned === false) setupState = "instance_desktops_not_provisioned";
  else if (!backendConfigured && launchDisabled) setupState = "instance_desktops_not_provisioned";
  else if (["error", "unhealthy", "down", "offline"].includes(backendStatus) || tenantHint.unhealthy) setupState = "desktop_backend_unhealthy";
  else if (tenantHint.userProvisioned === false) setupState = "user_desktop_not_provisioned";
  else if (!requiredDesktopAllowed(skillId, env, tenantVm)) setupState = "user_desktop_not_provisioned";

  return {
    available: setupState === "available",
    setupState,
    reason: setupState,
    message: setupState === "available" ? "Managed Desktop is available for this chat." : desktopProvisioningMessage(setupState),
    instance: {
      mode: mode || (hasManagedBackend ? "browserctl" : "profiles"),
      provisioned: setupState !== "instance_desktops_not_provisioned" && setupState !== "instance_desktops_disabled",
      backendConfigured,
      backendStatus: backendStatus || (backendConfigured ? "configured" : "not_configured"),
      userDesktopsEnabled: userDesktopsEnabled !== false,
    },
    user: {
      provisioned: setupState === "available",
      requiredDesktopAllowed: requiredDesktopAllowed(skillId, env, tenantVm),
      tenantDesktopStatus: tenantHint.status,
    },
  };
}
