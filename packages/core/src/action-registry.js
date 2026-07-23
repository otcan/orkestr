const actionRegistry = [
  { provider: "gmail", verb: "search", object: "message", handler: "orkestr_search_gmail", approval: "none", options: ["query", "maxResults"] },
  { provider: "gmail", verb: "read", object: "message", handler: "orkestr_read_gmail_message", approval: "none", options: ["messageId"] },
  { provider: "gmail", verb: "read", object: "latest_message", handler: "orkestr_read_latest_gmail_message", approval: "none", options: ["query"] },
  { provider: "gmail", verb: "watch", object: "notification", handler: "orkestr_create_automation", approval: "none", options: ["query", "interval", "target", "maxItemsPerRun"] },
  { provider: "gmail", verb: "update", object: "notification", handler: "orkestr_update_automation", approval: "none", options: ["automationId", "notificationId", "query", "interval", "target", "maxItemsPerRun", "enabled"] },
  { provider: "gmail", verb: "pause", object: "notification", handler: "orkestr_pause_automation", approval: "none", options: ["automationId", "notificationId"] },
  { provider: "gmail", verb: "resume", object: "notification", handler: "orkestr_resume_automation", approval: "none", options: ["automationId", "notificationId"] },
  { provider: "gmail", verb: "run", object: "notification", handler: "orkestr_run_automation", approval: "none", options: ["automationId", "notificationId"] },
  { provider: "gmail", verb: "delete", object: "notification", handler: "orkestr_delete_automation", approval: "confirm", options: ["automationId", "notificationId"] },
  { provider: "gmail", verb: "create", object: "draft", handler: "orkestr_create_gmail_draft", approval: "confirm", options: ["to", "cc", "bcc", "subject", "body"] },
  { provider: "gmail", verb: "send", object: "draft", handler: "orkestr_send_gmail_draft", approval: "explicit", options: ["draftId"] },
  { provider: "gmail", verb: "send", object: "message", handler: "orkestr_send_gmail_message", approval: "explicit", options: ["to", "cc", "bcc", "subject", "body"] },
  { provider: "gmail", verb: "modify", object: "message", handler: "orkestr_modify_gmail_message", approval: "confirm", options: ["messageId", "action", "labelIds", "addLabelIds", "removeLabelIds"] },
  { provider: "outlook", verb: "search", object: "message", handler: "orkestr_search_skills", approval: "none", options: ["query", "maxResults"], status: "planned" },
  { provider: "outlook", verb: "read", object: "message", handler: "orkestr_run_skill_action", approval: "none", options: ["messageId"], status: "planned" },
  { provider: "outlook", verb: "send", object: "message", handler: "orkestr_run_skill_action", approval: "explicit", options: ["to", "subject", "body"], status: "planned" },
  { provider: "calendar", verb: "list", object: "event", handler: "orkestr_list_google_calendar_events", approval: "none", options: ["calendarId", "timeMin", "timeMax", "maxResults"] },
  { provider: "calendar", verb: "create", object: "event", handler: "orkestr_create_google_calendar_event", approval: "explicit", options: ["calendarId", "summary", "description", "location", "startDateTime", "endDateTime", "startDate", "endDate", "timeZone", "sendUpdates"] },
  { provider: "calendar", verb: "update", object: "event", handler: "orkestr_update_google_calendar_event", approval: "explicit", options: ["calendarId", "eventId", "summary", "description", "location", "startDateTime", "endDateTime", "startDate", "endDate", "timeZone", "sendUpdates"] },
  { provider: "calendar", verb: "delete", object: "event", handler: "orkestr_delete_google_calendar_event", approval: "explicit", options: ["calendarId", "eventId", "sendUpdates"] },
  { provider: "drive", verb: "read", object: "file", handler: "orkestr_get_google_drive_file", approval: "none", options: ["fileId", "includeContent", "exportMimeType", "maxChars"] },
  { provider: "jira", verb: "list", object: "issue", handler: "orkestr_run_skill_action", approval: "none", options: ["project", "jql"], status: "planned" },
  { provider: "jira", verb: "read", object: "issue", handler: "orkestr_run_skill_action", approval: "none", options: ["issueKey"], status: "planned" },
  { provider: "jira", verb: "create", object: "issue", handler: "orkestr_run_skill_action", approval: "confirm", options: ["project", "summary", "description"], status: "planned" },
  { provider: "jira", verb: "update", object: "issue", handler: "orkestr_run_skill_action", approval: "confirm", options: ["issueKey", "fields"], status: "planned" },
  { provider: "whatsapp", verb: "send", object: "message", handler: "orkestr_run_skill_action", approval: "explicit", options: ["chatId", "text"], status: "planned" },
  { provider: "whatsapp", verb: "route", object: "chat", handler: "orkestr_run_skill_action", approval: "confirm", options: ["chatId", "threadId"], status: "planned" },
  { provider: "timer", verb: "create", object: "timer", handler: "orkestr_create_automation", approval: "none", options: ["cadence", "delay", "runAt", "time", "timezone", "every", "prompt", "target", "enabled"] },
  { provider: "timer", verb: "update", object: "timer", handler: "orkestr_update_automation", approval: "none", options: ["automationId", "cadence", "prompt", "enabled"] },
  { provider: "timer", verb: "pause", object: "timer", handler: "orkestr_pause_automation", approval: "none", options: ["automationId"] },
  { provider: "timer", verb: "resume", object: "timer", handler: "orkestr_resume_automation", approval: "none", options: ["automationId"] },
  { provider: "timer", verb: "delete", object: "timer", handler: "orkestr_delete_automation", approval: "confirm", options: ["automationId"] },
  { provider: "timer", verb: "run", object: "timer", handler: "orkestr_run_automation", approval: "none", options: ["automationId"] },
  { provider: "push", verb: "create", object: "connector_push", handler: "orkestr_create_automation", approval: "none", options: ["provider", "query", "promptTemplate", "interval"] },
  { provider: "push", verb: "update", object: "connector_push", handler: "orkestr_update_automation", approval: "none", options: ["automationId", "enabled", "query", "promptTemplate"] },
  { provider: "push", verb: "pause", object: "connector_push", handler: "orkestr_pause_automation", approval: "none", options: ["automationId"] },
  { provider: "push", verb: "resume", object: "connector_push", handler: "orkestr_resume_automation", approval: "none", options: ["automationId"] },
  { provider: "push", verb: "delete", object: "connector_push", handler: "orkestr_delete_automation", approval: "confirm", options: ["automationId"] },
  { provider: "push", verb: "run", object: "connector_push", handler: "orkestr_run_automation", approval: "none", options: ["automationId", "sourceItemsJson"] },
  { provider: "automation", verb: "doctor", object: "automation", handler: "orkestr_doctor_automations", approval: "none", options: [] },
];

function clean(value = "") {
  return String(value || "").trim();
}

export function actionKeyFor(provider = "", verb = "", object = "") {
  return [provider, verb, object].map((part) => clean(part).toLowerCase()).join(".");
}

function normalizeAction(entry = {}, { includeHandler = false } = {}) {
  const normalized = {
    actionKey: actionKeyFor(entry.provider, entry.verb, entry.object),
    provider: entry.provider,
    verb: entry.verb,
    object: entry.object,
    approval: entry.approval || "none",
    status: entry.status || "available",
    options: Array.isArray(entry.options) ? entry.options : [],
  };
  if (entry.capability) normalized.capability = entry.capability;
  if (includeHandler) normalized.handler = entry.handler || entry.tool || "";
  return normalized;
}

export function listActionRegistry({ provider = "", verb = "", object = "" } = {}) {
  const providerFilter = clean(provider).toLowerCase();
  const verbFilter = clean(verb).toLowerCase();
  const objectFilter = clean(object).toLowerCase();
  return actionRegistry.filter((entry) =>
    (!providerFilter || entry.provider === providerFilter) &&
    (!verbFilter || entry.verb === verbFilter) &&
    (!objectFilter || entry.object === objectFilter)
  ).map((entry) => normalizeAction(entry));
}

export function findActionRegistryEntry({ actionKey = "", provider = "", verb = "", object = "" } = {}) {
  const key = clean(actionKey).toLowerCase();
  const providerFilter = clean(provider).toLowerCase();
  const verbFilter = clean(verb).toLowerCase();
  const objectFilter = clean(object).toLowerCase();
  const entry = actionRegistry.find((candidate) => {
    if (key) return actionKeyFor(candidate.provider, candidate.verb, candidate.object) === key;
    return candidate.provider === providerFilter && candidate.verb === verbFilter && candidate.object === objectFilter;
  });
  return entry ? normalizeAction(entry, { includeHandler: true }) : null;
}

export function actionRegistryInstructions() {
  return [
    "Action registry policy: model tool choice is the generic action router. Discover actions with orkestr_list_actions, then execute available actions with orkestr_run_action using provider + verb + object or actionKey. Do not call provider-specific tool names or use stale connector context as a pre-model action selector.",
    "Choose actions by provider + verb + object + options. Current supported automation objects are timer, gmail notification, connector_push, and automation doctor diagnostics; Jira, Outlook, WhatsApp, and additional Drive actions are registry-described extension points until their connector tools are enabled.",
    "Timers are prompts. When a timer fires, Orkestr injects the timer prompt into the target chat/thread, and that prompt may call tools under the same tenant-scoped permissions.",
    "For timers, Gmail search/read/watch/update/delete/run/pause/resume, automation doctor diagnostics, Google Calendar, Google Drive, and Gmail draft/send/modify actions, use the action router rather than provider-named tools.",
  ].join("\n");
}
