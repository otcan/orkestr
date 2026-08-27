function clean(value) {
  return String(value || "").trim();
}

function pick(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && clean(value)) return value;
  }
  return "";
}

function positiveInt(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function displayNumber(value) {
  const text = clean(value).replace(/^:/, "");
  return positiveInt(text);
}

function portFrom(source = {}, ...keys) {
  for (const key of keys) {
    const value = positiveInt(source[key]);
    if (value) return value;
  }
  return null;
}

export function normalizeDesktopAddressFields(source = {}) {
  const nested = source.ports && typeof source.ports === "object" && !Array.isArray(source.ports) ? source.ports : {};
  const runtime = source.runtime && typeof source.runtime === "object" && !Array.isArray(source.runtime) ? source.runtime : {};
  const debugPort = portFrom(source, "debugPort", "debug_port", "cdpPort", "cdp_port", "remoteDebuggingPort", "remote_debugging_port")
    || portFrom(nested, "debug", "debugPort", "debug_port", "cdp", "cdpPort", "cdp_port")
    || portFrom(runtime, "debugPort", "debug_port", "cdpPort", "cdp_port");
  const vncPort = portFrom(source, "vncPort", "vnc_port", "rfbPort", "rfb_port")
    || portFrom(nested, "vnc", "vncPort", "vnc_port", "rfb", "rfbPort", "rfb_port")
    || portFrom(runtime, "vncPort", "vnc_port", "rfbPort", "rfb_port");
  const webPort = portFrom(source, "webPort", "web_port", "novncPort", "novnc_port", "noVncPort", "no_vnc_port", "websockifyPort", "websockify_port")
    || portFrom(nested, "web", "webPort", "web_port", "novnc", "novncPort", "novnc_port", "websockify", "websockifyPort")
    || portFrom(runtime, "webPort", "web_port", "novncPort", "novnc_port", "websockifyPort", "websockify_port");
  const explicitDisplay = pick(source.displayNumber, source.display_number, source.display, source.xDisplay, source.x_display, nested.displayNumber, nested.display_number, nested.display, runtime.displayNumber, runtime.display_number, runtime.display);
  const output = {};
  if (debugPort) output.debugPort = debugPort;
  if (vncPort) output.vncPort = vncPort;
  if (webPort) output.webPort = webPort;
  const parsedDisplay = displayNumber(explicitDisplay);
  if (parsedDisplay) output.displayNumber = parsedDisplay;
  return output;
}

export function desktopRuntimeAddresses(desktop = {}, index = 0, bases = {}) {
  const normalized = normalizeDesktopAddressFields(desktop);
  const safeIndex = Number.isInteger(index) && index >= 0 ? index : 0;
  const baseDebug = positiveInt(bases.debugPortBase) || 9222;
  const baseVnc = positiveInt(bases.vncPortBase) || 5901;
  const baseWeb = positiveInt(bases.webPortBase) || 6080;
  const baseDisplay = positiveInt(bases.displayBase) || 90;
  const display = normalized.displayNumber || baseDisplay + safeIndex;
  return {
    debugPort: normalized.debugPort || baseDebug + safeIndex,
    vncPort: normalized.vncPort || baseVnc + safeIndex,
    webPort: normalized.webPort || baseWeb + safeIndex,
    displayNumber: display,
    display: `:${display}`,
  };
}

function conflictKey(field, value) {
  return `${field}:${String(value)}`;
}

export function desktopAddressConflicts(desktops = [], bases = {}) {
  const groups = new Map();
  for (const [index, desktop] of (Array.isArray(desktops) ? desktops : []).entries()) {
    const slug = clean(desktop?.slug || desktop?.id);
    if (!slug) continue;
    const addresses = desktopRuntimeAddresses(desktop, index, bases);
    for (const [field, value] of Object.entries({
      display: addresses.display,
      debugPort: addresses.debugPort,
      vncPort: addresses.vncPort,
      webPort: addresses.webPort,
    })) {
      const key = conflictKey(field, value);
      const group = groups.get(key) || { field, value, slugs: [] };
      group.slugs.push(slug);
      groups.set(key, group);
    }
  }
  return [...groups.values()]
    .filter((group) => group.slugs.length > 1)
    .map((group) => ({ ...group, slugs: [...new Set(group.slugs)].sort() }));
}

export function desktopAddressConflictsForSlug(desktops = [], slug = "", bases = {}) {
  const target = clean(slug);
  if (!target) return [];
  return desktopAddressConflicts(desktops, bases).filter((conflict) => conflict.slugs.includes(target));
}

export function desktopAddressConflictMessage(slug = "", conflicts = []) {
  const target = clean(slug) || "desktop";
  const details = (Array.isArray(conflicts) ? conflicts : [])
    .map((conflict) => `${conflict.field} ${conflict.value} shared by ${conflict.slugs.join(", ")}`)
    .join("; ");
  return `desktop_runtime_address_conflict: ${target}${details ? `: ${details}` : ""}`;
}
