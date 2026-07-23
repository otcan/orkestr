const baseScopes = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];

const capabilityDefinitions = [
  {
    id: "gmail_read",
    label: "Gmail read",
    summary: "Search, list, fetch, and summarize Gmail messages.",
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
  },
  {
    id: "gmail_actions",
    label: "Gmail actions",
    summary: "Archive messages, mark them read or unread, and add or remove labels.",
    scopes: ["https://www.googleapis.com/auth/gmail.modify"],
  },
  {
    id: "gmail_send",
    label: "Gmail send",
    summary: "Send user-approved Gmail messages.",
    scopes: ["https://www.googleapis.com/auth/gmail.send"],
  },
  {
    id: "gmail_drafts",
    label: "Gmail drafts",
    summary: "Create and send user-approved Gmail drafts.",
    scopes: ["https://www.googleapis.com/auth/gmail.compose"],
  },
  {
    id: "calendar_read",
    label: "Calendar read",
    summary: "List Google Calendar events for approved date ranges.",
    scopes: ["https://www.googleapis.com/auth/calendar.events.readonly"],
    acceptedScopes: [
      "https://www.googleapis.com/auth/calendar.events.owned",
      "https://www.googleapis.com/auth/calendar.events",
    ],
  },
  {
    id: "calendar_actions",
    label: "Calendar actions",
    summary: "Create, update, and delete user-approved events on calendars you own.",
    scopes: ["https://www.googleapis.com/auth/calendar.events.owned"],
    acceptedScopes: ["https://www.googleapis.com/auth/calendar.events"],
  },
  {
    id: "drive_file",
    label: "Drive selected files",
    summary: "Read metadata and content only for files selected or created with Orkestr.",
    scopes: ["https://www.googleapis.com/auth/drive.file"],
  },
];

const defaultGmailCapabilities = ["gmail_send"];
const definitionById = new Map(capabilityDefinitions.map((definition) => [definition.id, definition]));

function clean(value) {
  return String(value || "").trim();
}

function unique(values = []) {
  const seen = new Set();
  const result = [];
  for (const value of values.map(clean).filter(Boolean)) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

export function googleWorkspaceBaseScopes() {
  return [...baseScopes];
}

export function googleWorkspaceCapabilityDefinitions() {
  return capabilityDefinitions.map((definition) => ({
    ...definition,
    scopes: [...definition.scopes],
    acceptedScopes: [...(definition.acceptedScopes || [])],
  }));
}

export function googleWorkspaceDefaultGmailCapabilities() {
  return [...defaultGmailCapabilities];
}

export function googleWorkspaceAllowedCapabilities(env = process.env, configured = "") {
  const raw = Array.isArray(configured)
    ? configured
    : clean(
      configured ||
        env.ORKESTR_GOOGLE_OAUTH_ALLOWED_CAPABILITIES ||
        env.GOOGLE_OAUTH_ALLOWED_CAPABILITIES,
    ).split(/[\s,]+/g);
  const values = raw.map(clean).filter(Boolean);
  if (values.some((value) => ["*", "all"].includes(value.toLowerCase()))) {
    return capabilityDefinitions.map((definition) => definition.id);
  }
  return normalizeGoogleWorkspaceCapabilities(values, defaultGmailCapabilities);
}

export function requireAllowedGoogleWorkspaceCapabilities(input = [], env = process.env, configured = "") {
  const requested = normalizeGoogleWorkspaceCapabilities(input, defaultGmailCapabilities);
  const allowed = new Set(googleWorkspaceAllowedCapabilities(env, configured));
  const denied = requested.filter((capability) => !allowed.has(capability));
  if (denied.length) {
    const error = new Error(`google_workspace_capability_not_approved:${denied.join(",")}`);
    error.code = "google_workspace_capability_not_approved";
    error.statusCode = 403;
    error.deniedCapabilities = denied;
    throw error;
  }
  return requested;
}

export function normalizeGoogleWorkspaceCapabilities(input = [], fallback = defaultGmailCapabilities) {
  const values = Array.isArray(input)
    ? input
    : clean(input).split(/[\s,]+/g);
  const normalized = unique(values.map((value) => clean(value).toLowerCase()))
    .filter((value) => definitionById.has(value));
  return normalized.length ? normalized : [...fallback];
}

export function googleWorkspaceScopesForCapabilities(input = []) {
  const capabilities = normalizeGoogleWorkspaceCapabilities(input);
  const effectiveCapabilities = capabilities.includes("calendar_actions")
    ? capabilities.filter((capability) => capability !== "calendar_read")
    : capabilities;
  return unique([
    ...baseScopes,
    ...effectiveCapabilities.flatMap((capability) => definitionById.get(capability)?.scopes || []),
  ]);
}

export function googleWorkspaceCapabilitiesForScopes(scopeValue = "", fallback = []) {
  const values = Array.isArray(scopeValue)
    ? scopeValue.map(clean).filter(Boolean)
    : clean(scopeValue).split(/[\s,]+/g).map(clean).filter(Boolean);
  const scopes = new Set(values);
  const capabilities = [];
  for (const definition of capabilityDefinitions) {
    const acceptedScopes = [...definition.scopes, ...(definition.acceptedScopes || [])];
    if (acceptedScopes.some((scope) => scopes.has(scope))) capabilities.push(definition.id);
  }
  return capabilities.length ? capabilities : (values.length ? [] : [...fallback]);
}

export function googleWorkspaceCapabilityDisclosure(input = []) {
  const selected = new Set(normalizeGoogleWorkspaceCapabilities(input));
  return capabilityDefinitions
    .filter((definition) => selected.has(definition.id))
    .map((definition) => ({
      id: definition.id,
      label: definition.label,
      summary: definition.summary,
      scopes: [...definition.scopes],
    }));
}

export function googleWorkspaceCapabilityLabels(input = []) {
  const selected = new Set(normalizeGoogleWorkspaceCapabilities(input, []));
  return capabilityDefinitions
    .filter((definition) => selected.has(definition.id))
    .map((definition) => definition.label);
}

export function googleWorkspaceCapabilitySummary(input = []) {
  const labels = googleWorkspaceCapabilityLabels(input);
  return labels.length ? labels.join(", ") : "No Google Workspace capabilities";
}
