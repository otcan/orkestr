function currentUrl(value = "") {
  try {
    return new URL(String(value || "http://localhost/"));
  } catch {
    return new URL("http://localhost/");
  }
}

export function canonicalThreadPanelUrl(canonicalUrl = "", panel = "chat", sourceUrl = "", preserveLocation = false) {
  if (!canonicalUrl) return "";
  try {
    const current = currentUrl(sourceUrl);
    const target = new URL(String(canonicalUrl), current);
    target.search = preserveLocation ? current.search : "";
    target.hash = preserveLocation ? current.hash : "";
    target.pathname = target.pathname.replace(/\/+$/, "");
    if (panel && panel !== "chat") target.pathname = `${target.pathname}/${encodeURIComponent(panel)}`;
    return target.toString();
  } catch {
    return "";
  }
}

export function navigateCanonicalThreadTarget(targetUrl = "", options = {}) {
  if (!targetUrl) return { navigated: false, crossOrigin: false };
  const current = currentUrl(options.currentUrl);
  let target;
  try {
    target = new URL(String(targetUrl), current);
  } catch {
    return { navigated: false, crossOrigin: false };
  }
  const mode = options.mode === "replace" ? "replace" : "push";
  if (target.origin !== current.origin) {
    if (mode === "replace") options.location?.replace?.(target.toString());
    else options.location?.assign?.(target.toString());
    return { navigated: true, crossOrigin: true, url: target.toString() };
  }
  const next = `${target.pathname}${target.search}${target.hash}`;
  const present = `${current.pathname}${current.search}${current.hash}`;
  if (next !== present) {
    if (mode === "replace") options.history?.replaceState?.({}, "", next);
    else options.history?.pushState?.({}, "", next);
  }
  return { navigated: next !== present, crossOrigin: false, url: next };
}
