// Cookie header parsing shared by the auth, desktop-share and proxy paths.
// Cookie values are attacker-controlled: a malformed percent-escape (for
// example `%E0%A4%A`) must read as an empty value, never throw a URIError that
// surfaces as a 500.

export function decodeComponentOrEmpty(value = "") {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return "";
  }
}

export function cookieHeaderValues(header = "", name = "") {
  const values = [];
  for (const part of String(header || "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) values.push(decodeComponentOrEmpty(rest.join("=")));
  }
  return values.filter(Boolean);
}

export function cookieHeaderValue(header = "", name = "") {
  return cookieHeaderValues(header, name)[0] || "";
}
