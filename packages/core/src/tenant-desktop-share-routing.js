function clean(value = "") {
  return String(value || "").trim();
}

function trimSlash(value = "") {
  return clean(value).replace(/\/+$/, "");
}

function encodedPathSegment(value = "") {
  return encodeURIComponent(clean(value)).replace(/%2F/gi, "-");
}

function safeTenantVmId(value = "") {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
}

export function tenantDesktopShareUrlTemplate(tenantVmId = "", publicBaseUrl = "") {
  const id = safeTenantVmId(tenantVmId);
  const base = trimSlash(publicBaseUrl);
  if (!id || !base) return "";
  return `${base}/desktop-share/tvm/${encodedPathSegment(id)}/{subdomain}/{shareId}?key={key}`;
}

export function tenantDesktopSharePath({ tenantVmId = "", subdomain = "", shareId = "", key = "" } = {}) {
  const id = safeTenantVmId(tenantVmId);
  const tenantSubdomain = clean(subdomain).toLowerCase();
  const resolvedShareId = clean(shareId);
  if (!id || !tenantSubdomain || !resolvedShareId) return "";
  const path = `/desktop-share/tvm/${encodedPathSegment(id)}/${encodedPathSegment(tenantSubdomain)}/${encodedPathSegment(resolvedShareId)}`;
  const shareKey = clean(key);
  return shareKey ? `${path}?key=${encodeURIComponent(shareKey)}` : path;
}

export function parseTenantDesktopSharePath(pathname = "") {
  const parts = clean(pathname).split("/").filter(Boolean);
  if (parts.length < 5 || parts[0] !== "desktop-share" || parts[1] !== "tvm") return null;
  try {
    return {
      tenantVmId: safeTenantVmId(decodeURIComponent(parts[2] || "")),
      subdomain: clean(decodeURIComponent(parts[3] || "")).toLowerCase(),
      shareId: clean(decodeURIComponent(parts[4] || "")),
    };
  } catch {
    return null;
  }
}

export function parseLegacyDesktopSharePath(pathname = "") {
  const parts = clean(pathname).split("/").filter(Boolean);
  if (parts[0] !== "desktop-share") return null;
  if (parts.length >= 3) return { subdomain: clean(parts[1]).toLowerCase(), shareId: clean(parts[2]) };
  if (parts.length >= 2) return { subdomain: "", shareId: clean(parts[1]) };
  return null;
}

export function tenantDesktopRoutePrefix(tenantVmId = "") {
  const id = safeTenantVmId(tenantVmId);
  return id ? `/tenant-vms/${encodedPathSegment(id)}/desktop` : "";
}

export function rewriteTenantDesktopUrl(value = "", tenantVmId = "") {
  const raw = clean(value);
  const id = safeTenantVmId(tenantVmId);
  if (!raw || !id) return raw;
  let parsed;
  try {
    parsed = new URL(raw, "http://orkestr.local");
  } catch {
    return raw;
  }
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts[0] !== "desktop" || !parts[1]) return raw;
  const slug = clean(decodeURIComponent(parts[1] || ""));
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(slug)) return raw;
  const encodedTenant = encodedPathSegment(id);
  const encodedSlug = encodedPathSegment(slug);
  const rest = parts.slice(2).map((part) => {
    try {
      return encodedPathSegment(decodeURIComponent(part));
    } catch {
      return encodedPathSegment(part);
    }
  });
  parsed.pathname = `/tenant-vms/${encodedTenant}/desktop/${encodedSlug}${rest.length ? `/${rest.join("/")}` : ""}`;
  const websockifyPath = parsed.searchParams.get("path");
  if (websockifyPath) {
    const websocketParts = websockifyPath.split("/").filter(Boolean);
    if (websocketParts[0] === "desktop" && websocketParts[1]) {
      const wsSlug = clean(decodeURIComponent(websocketParts[1]));
      parsed.searchParams.set("path", `tenant-vms/${encodedTenant}/desktop/${encodedPathSegment(wsSlug)}/${websocketParts.slice(2).join("/") || "websockify"}`);
    }
  }
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

export function tenantDesktopShareCookiePresent(cookieHeader = "") {
  return String(cookieHeader || "")
    .split(";")
    .some((part) => part.trim().startsWith("orkestr_desktop_share="));
}
