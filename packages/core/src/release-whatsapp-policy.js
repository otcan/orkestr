const enabledValues = new Set(["1", "true", "yes", "on", "required"]);

function clean(value = "") {
  return String(value || "").trim();
}

function cleanLower(value = "") {
  return clean(value).toLowerCase();
}

export function splitList(value) {
  if (Array.isArray(value)) return value.flatMap((item) => splitList(item));
  const text = clean(value);
  if (!text) return [];
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return splitList(parsed);
    } catch {
      // Fall back to delimiter parsing for operator-provided env values.
    }
  }
  return text.split(/[,\s]+/g).map((item) => clean(item)).filter(Boolean);
}

export function firstList(...values) {
  for (const value of values) {
    const items = splitList(value);
    if (items.length) return [...new Set(items)];
  }
  return [];
}

function labelRequiredAccounts(labels = {}) {
  return firstList(
    labels.requiredWhatsAppAccounts,
    labels["required-whatsapp-accounts"],
    labels.whatsappRequiredAccounts,
    labels["whatsapp-required-accounts"],
    labels.releaseRequiredWhatsAppAccounts,
    labels["release-required-whatsapp-accounts"],
  );
}

export function releaseInstanceRequiresWhatsApp(instance = {}) {
  const labels = instance.labels || {};
  if (enabledValues.has(cleanLower(labels.requireWhatsAppConnectivity || labels["require-whatsapp-connectivity"]))) return true;
  if (enabledValues.has(cleanLower(labels.whatsappConnectivityCheck || labels["whatsapp-connectivity-check"]))) return true;
  if (labelRequiredAccounts(labels).length) return true;
  return cleanLower(labels.router) === "parent-whatsapp";
}

export function releaseInstanceRequiredWhatsAppAccounts(instance = {}, options = {}, env = process.env) {
  const labels = instance.labels || {};
  return firstList(
    options.requiredWhatsAppAccounts,
    options.whatsappRequiredAccounts,
    labelRequiredAccounts(labels),
    ...(releaseInstanceRequiresWhatsApp(instance) ? [
      env.ORKESTR_RELEASE_REQUIRED_WHATSAPP_ACCOUNTS,
      env.ORKESTR_REQUIRED_WHATSAPP_ACCOUNTS,
    ] : []),
  );
}
