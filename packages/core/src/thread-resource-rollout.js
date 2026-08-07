const writeModes = new Set(["legacy", "dual", "unified"]);
const resourceTypes = new Set(["desktop", "oxrm", "mailbox"]);
const clean = (value = "") => String(value || "").trim();

function resourceType(value = "") {
  const type = clean(value).toLowerCase();
  return resourceTypes.has(type) ? type : "";
}

export function threadResourceWriteMode(resourceTypeValue = "", env = process.env) {
  const type = resourceType(resourceTypeValue);
  const configured = clean(
    env[`ORKESTR_THREAD_RESOURCE_${type.toUpperCase()}_WRITE_MODE`] ||
    env[`ORKESTR_${type.toUpperCase()}_WRITE_MODE`] ||
    env.ORKESTR_THREAD_RESOURCE_WRITE_MODE ||
    "unified",
  ).toLowerCase();
  return writeModes.has(configured) ? configured : configured ? "invalid" : "unified";
}

export function threadResourceWritePlan(resourceTypeValue = "", env = process.env) {
  const type = resourceType(resourceTypeValue);
  const requested = threadResourceWriteMode(type, env);
  // V1 has no retained legacy policy writer. Mailbox has a legacy ingress path,
  // but it is not a grants writer and is never an owner-wide fallback.
  return {
    resourceType: type,
    requested,
    effective: requested === "unified" ? "unified" : "unsupported",
    legacyWriteSupported: false,
    rollback: type === "mailbox"
      ? { supported: true, action: "set_access_mode_off", preservesUnifiedRecords: true, scope: "legacy_connector_inbox_only" }
      : { supported: false, action: "unsupported", preservesUnifiedRecords: true, scope: "none" },
  };
}

export function requireUnifiedThreadResourceWriteMode(resourceTypeValue = "", policyError, env = process.env) {
  const plan = threadResourceWritePlan(resourceTypeValue, env);
  if (plan.effective !== "unified") throw policyError("thread_resource_legacy_write_mode_unsupported", 409);
  return plan;
}
