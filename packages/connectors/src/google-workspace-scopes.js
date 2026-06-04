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
    label: "Gmail send and drafts",
    summary: "Create drafts and send user-approved Gmail messages.",
    scopes: [
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/gmail.compose",
    ],
  },
  {
    id: "calendar_read",
    label: "Calendar read",
    summary: "List Google Calendar events for approved date ranges.",
    scopes: ["https://www.googleapis.com/auth/calendar.events.readonly"],
  },
  {
    id: "drive_file",
    label: "Drive selected files",
    summary: "Read metadata and content only for files selected or created with Orkestr.",
    scopes: ["https://www.googleapis.com/auth/drive.file"],
  },
];

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
  }));
}

export function normalizeGoogleWorkspaceCapabilities(input = [], fallback = ["gmail_read"]) {
  const values = Array.isArray(input)
    ? input
    : clean(input).split(/[\s,]+/g);
  const normalized = unique(values.map((value) => clean(value).toLowerCase()))
    .filter((value) => definitionById.has(value));
  return normalized.length ? normalized : [...fallback];
}

export function googleWorkspaceScopesForCapabilities(input = []) {
  const capabilities = normalizeGoogleWorkspaceCapabilities(input);
  return unique([
    ...baseScopes,
    ...capabilities.flatMap((capability) => definitionById.get(capability)?.scopes || []),
  ]);
}

export function googleWorkspaceCapabilitiesForScopes(scopeValue = "", fallback = []) {
  const scopes = new Set(Array.isArray(scopeValue)
    ? scopeValue.map(clean).filter(Boolean)
    : clean(scopeValue).split(/[\s,]+/g).map(clean).filter(Boolean));
  const capabilities = [];
  for (const definition of capabilityDefinitions) {
    if (definition.scopes.some((scope) => scopes.has(scope))) capabilities.push(definition.id);
  }
  return capabilities.length ? capabilities : [...fallback];
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

