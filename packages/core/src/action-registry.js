const actionRegistry = [
  { provider: "gmail", verb: "search", object: "message", tool: "orkestr_search_gmail", approval: "none", options: ["query", "maxResults"] },
  { provider: "gmail", verb: "read", object: "message", tool: "orkestr_read_gmail_message", approval: "none", options: ["messageId"] },
  { provider: "gmail", verb: "watch", object: "notification", tool: "orkestr_create_automation", approval: "none", options: ["query", "interval", "target", "maxItemsPerRun"] },
  { provider: "gmail", verb: "create", object: "draft", tool: "orkestr_create_gmail_draft", approval: "confirm", options: ["to", "subject", "body"] },
  { provider: "gmail", verb: "send", object: "message", tool: "orkestr_send_gmail_message", approval: "explicit", options: ["to", "subject", "body"] },
  { provider: "outlook", verb: "search", object: "message", tool: "orkestr_search_skills", approval: "none", options: ["query", "maxResults"], status: "planned" },
  { provider: "outlook", verb: "read", object: "message", tool: "orkestr_run_skill_action", approval: "none", options: ["messageId"], status: "planned" },
  { provider: "outlook", verb: "send", object: "message", tool: "orkestr_run_skill_action", approval: "explicit", options: ["to", "subject", "body"], status: "planned" },
  { provider: "calendar", verb: "list", object: "event", tool: "orkestr_list_google_calendar_events", approval: "none", options: ["calendarId", "timeMin", "timeMax"] },
  { provider: "calendar", verb: "create", object: "event", tool: "orkestr_create_google_calendar_event", approval: "explicit", options: ["calendarId", "title", "start", "end", "timezone"] },
  { provider: "calendar", verb: "update", object: "event", tool: "orkestr_update_google_calendar_event", approval: "explicit", options: ["calendarId", "eventId", "title", "start", "end"] },
  { provider: "calendar", verb: "delete", object: "event", tool: "orkestr_delete_google_calendar_event", approval: "explicit", options: ["calendarId", "eventId"] },
  { provider: "drive", verb: "read", object: "file", tool: "orkestr_get_google_drive_file", approval: "none", options: ["fileId"] },
  { provider: "jira", verb: "list", object: "issue", tool: "orkestr_run_skill_action", approval: "none", options: ["project", "jql"], status: "planned" },
  { provider: "jira", verb: "read", object: "issue", tool: "orkestr_run_skill_action", approval: "none", options: ["issueKey"], status: "planned" },
  { provider: "jira", verb: "create", object: "issue", tool: "orkestr_run_skill_action", approval: "confirm", options: ["project", "summary", "description"], status: "planned" },
  { provider: "jira", verb: "update", object: "issue", tool: "orkestr_run_skill_action", approval: "confirm", options: ["issueKey", "fields"], status: "planned" },
  { provider: "whatsapp", verb: "send", object: "message", tool: "orkestr_run_skill_action", approval: "explicit", options: ["chatId", "text"], status: "planned" },
  { provider: "whatsapp", verb: "route", object: "chat", tool: "orkestr_run_skill_action", approval: "confirm", options: ["chatId", "threadId"], status: "planned" },
  { provider: "timer", verb: "create", object: "timer", tool: "orkestr_create_automation", approval: "none", options: ["cadence", "prompt", "target", "timezone"] },
  { provider: "timer", verb: "update", object: "timer", tool: "orkestr_update_automation", approval: "none", options: ["automationId", "cadence", "prompt", "enabled"] },
  { provider: "timer", verb: "delete", object: "timer", tool: "orkestr_delete_automation", approval: "confirm", options: ["automationId"] },
  { provider: "timer", verb: "run", object: "timer", tool: "orkestr_run_automation", approval: "none", options: ["automationId"] },
  { provider: "push", verb: "create", object: "connector_push", tool: "orkestr_create_automation", approval: "none", options: ["provider", "query", "promptTemplate", "interval"] },
  { provider: "push", verb: "update", object: "connector_push", tool: "orkestr_update_automation", approval: "none", options: ["automationId", "enabled", "query", "promptTemplate"] },
  { provider: "push", verb: "delete", object: "connector_push", tool: "orkestr_delete_automation", approval: "confirm", options: ["automationId"] },
  { provider: "push", verb: "run", object: "connector_push", tool: "orkestr_run_automation", approval: "none", options: ["automationId", "sourceItemsJson"] },
];

function clean(value = "") {
  return String(value || "").trim();
}

export function listActionRegistry({ provider = "", verb = "", object = "" } = {}) {
  const providerFilter = clean(provider).toLowerCase();
  const verbFilter = clean(verb).toLowerCase();
  const objectFilter = clean(object).toLowerCase();
  return actionRegistry.filter((entry) =>
    (!providerFilter || entry.provider === providerFilter) &&
    (!verbFilter || entry.verb === verbFilter) &&
    (!objectFilter || entry.object === objectFilter)
  );
}

export function actionRegistryInstructions() {
  return [
    "Action registry policy: model tool choice is the action router. Do not use stale connector context as a pre-model action selector.",
    "Choose tools by provider + verb + object + options. Current supported automation objects are timer, gmail_notification, and connector_push; Jira, Outlook, WhatsApp, and additional Drive actions are registry-described extension points until their connector tools are enabled.",
    "Timers are prompts. When a timer fires, Orkestr injects the timer prompt into the target chat/thread, and that prompt may call tools under the same tenant-scoped permissions.",
    "For automation changes, prefer the generic automation tools when the user asks to add, modify, pause, resume, delete, or run timers and connector pushes.",
  ].join("\n");
}
