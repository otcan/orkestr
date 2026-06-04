import {
  createGoogleCalendarEvent,
  createGmailDraft,
  deleteGoogleCalendarEvent,
  getGoogleDriveFile,
  listGoogleCalendarEvents,
  modifyGmailMessage,
  sendGmailDraft,
  sendGmailMessage,
  updateGoogleCalendarEvent,
} from "./google-workspace.js";

function clean(value) {
  return String(value || "").trim();
}

function publicCalendarEvent(event = {}) {
  return {
    id: clean(event.id),
    summary: clean(event.summary),
    description: clean(event.description).slice(0, 2000),
    location: clean(event.location),
    start: event.start || null,
    end: event.end || null,
    status: clean(event.status),
    htmlLink: clean(event.htmlLink),
  };
}

function publicDriveFile(file = {}) {
  return {
    id: clean(file.id),
    name: clean(file.name),
    mimeType: clean(file.mimeType),
    size: clean(file.size),
    modifiedTime: clean(file.modifiedTime),
    webViewLink: clean(file.webViewLink),
  };
}

export function tenantApiAgentGoogleWorkspaceToolDefinitions() {
  return [
    {
      type: "function",
      name: "orkestr_modify_gmail_message",
      description: "Apply a granted Gmail action to a scoped message: archive, mark read/unread, or add/remove labels. Use only when the user asks to change a message.",
      parameters: {
        type: "object",
        properties: {
          messageId: { type: "string", description: "Gmail message id." },
          action: { type: "string", enum: ["archive", "mark_read", "mark_unread", "add_labels", "remove_labels"], description: "Message action to apply." },
          labelIds: { type: "array", items: { type: "string" }, description: "Label ids for add_labels or remove_labels, otherwise empty." },
          addLabelIds: { type: "array", items: { type: "string" }, description: "Explicit label ids to add, otherwise empty." },
          removeLabelIds: { type: "array", items: { type: "string" }, description: "Explicit label ids to remove, otherwise empty." },
        },
        required: ["messageId", "action", "labelIds", "addLabelIds", "removeLabelIds"],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "orkestr_create_gmail_draft",
      description: "Create a scoped Gmail draft for a user-approved email. Do not call this for spam, abuse, or messages the user has not asked to draft.",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string", description: "Recipient email address or comma-separated recipients." },
          cc: { type: "string", description: "Cc recipients or empty string." },
          bcc: { type: "string", description: "Bcc recipients or empty string." },
          subject: { type: "string", description: "Email subject." },
          body: { type: "string", description: "Plain text email body." },
        },
        required: ["to", "cc", "bcc", "subject", "body"],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "orkestr_send_gmail_draft",
      description: "Send an existing scoped Gmail draft after the user explicitly approves sending it.",
      parameters: {
        type: "object",
        properties: {
          draftId: { type: "string", description: "Gmail draft id to send." },
        },
        required: ["draftId"],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "orkestr_send_gmail_message",
      description: "Send a scoped Gmail message only after the user explicitly approves the final recipients, subject, and body.",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string", description: "Recipient email address or comma-separated recipients." },
          cc: { type: "string", description: "Cc recipients or empty string." },
          bcc: { type: "string", description: "Bcc recipients or empty string." },
          subject: { type: "string", description: "Email subject." },
          body: { type: "string", description: "Plain text email body." },
        },
        required: ["to", "cc", "bcc", "subject", "body"],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "orkestr_list_google_calendar_events",
      description: "List scoped Google Calendar events for an approved date range. Requires Calendar read capability.",
      parameters: {
        type: "object",
        properties: {
          calendarId: { type: "string", description: "Calendar id, usually primary." },
          timeMin: { type: "string", description: "RFC3339 lower bound, or empty string." },
          timeMax: { type: "string", description: "RFC3339 upper bound, or empty string." },
          maxResults: { type: "number", description: "Maximum events to return, 1 to 50." },
        },
        required: ["calendarId", "timeMin", "timeMax", "maxResults"],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "orkestr_create_google_calendar_event",
      description: "Create a scoped Google Calendar event after the user explicitly approves the event title, time, and calendar. Requires Calendar actions capability.",
      parameters: {
        type: "object",
        properties: {
          calendarId: { type: "string", description: "Calendar id, usually primary." },
          summary: { type: "string", description: "Event title." },
          description: { type: "string", description: "Event description or empty string." },
          location: { type: "string", description: "Event location or empty string." },
          startDateTime: { type: "string", description: "RFC3339 start date-time, or empty when using startDate." },
          endDateTime: { type: "string", description: "RFC3339 end date-time, or empty when using endDate." },
          startDate: { type: "string", description: "All-day start date YYYY-MM-DD, or empty when using startDateTime." },
          endDate: { type: "string", description: "All-day exclusive end date YYYY-MM-DD, or empty when using endDateTime." },
          timeZone: { type: "string", description: "IANA timezone, or empty string." },
          sendUpdates: { type: "string", enum: ["", "all", "externalOnly", "none"], description: "Google Calendar guest update behavior." },
        },
        required: ["calendarId", "summary", "description", "location", "startDateTime", "endDateTime", "startDate", "endDate", "timeZone", "sendUpdates"],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "orkestr_update_google_calendar_event",
      description: "Update a scoped Google Calendar event after the user explicitly approves the changed fields. Requires Calendar actions capability.",
      parameters: {
        type: "object",
        properties: {
          calendarId: { type: "string", description: "Calendar id, usually primary." },
          eventId: { type: "string", description: "Calendar event id." },
          summary: { type: "string", description: "New event title, or empty to leave unchanged." },
          description: { type: "string", description: "New event description, or empty to leave unchanged." },
          location: { type: "string", description: "New event location, or empty to leave unchanged." },
          startDateTime: { type: "string", description: "New RFC3339 start date-time, or empty." },
          endDateTime: { type: "string", description: "New RFC3339 end date-time, or empty." },
          startDate: { type: "string", description: "New all-day start date YYYY-MM-DD, or empty." },
          endDate: { type: "string", description: "New all-day exclusive end date YYYY-MM-DD, or empty." },
          timeZone: { type: "string", description: "IANA timezone, or empty string." },
          sendUpdates: { type: "string", enum: ["", "all", "externalOnly", "none"], description: "Google Calendar guest update behavior." },
        },
        required: ["calendarId", "eventId", "summary", "description", "location", "startDateTime", "endDateTime", "startDate", "endDate", "timeZone", "sendUpdates"],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "orkestr_delete_google_calendar_event",
      description: "Delete a scoped Google Calendar event only after the user explicitly approves deletion. Requires Calendar actions capability.",
      parameters: {
        type: "object",
        properties: {
          calendarId: { type: "string", description: "Calendar id, usually primary." },
          eventId: { type: "string", description: "Calendar event id." },
          sendUpdates: { type: "string", enum: ["", "all", "externalOnly", "none"], description: "Google Calendar guest update behavior." },
        },
        required: ["calendarId", "eventId", "sendUpdates"],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "orkestr_get_google_drive_file",
      description: "Read metadata, and optionally text content, for a Drive file selected or created through Orkestr. Requires drive.file capability; do not use broad Drive access.",
      parameters: {
        type: "object",
        properties: {
          fileId: { type: "string", description: "Google Drive file id." },
          includeContent: { type: "boolean", description: "Whether to fetch file content as text." },
          exportMimeType: { type: "string", description: "Export MIME type for Google Docs files, usually text/plain." },
          maxChars: { type: "number", description: "Maximum content characters to return, 1000 to 60000." },
        },
        required: ["fileId", "includeContent", "exportMimeType", "maxChars"],
        additionalProperties: false,
      },
      strict: true,
    },
  ];
}

export async function runTenantApiAgentGoogleWorkspaceTool(name = "", args = {}, context = {}, env = process.env) {
  const principal = context.principal || null;
  const fetchImpl = context.fetchImpl || fetch;
  const options = { principal };
  const tool = clean(name);
  if (tool === "orkestr_modify_gmail_message") {
    const result = await modifyGmailMessage(args, env, fetchImpl, options);
    return { handled: true, result: { ok: true, provider: "gmail", messageId: result.messageId, patch: result.patch, message: result.message } };
  }
  if (tool === "orkestr_create_gmail_draft") {
    const result = await createGmailDraft(args, env, fetchImpl, options);
    return { handled: true, result: { ok: true, provider: "gmail", draft: { id: clean(result.draft?.id), message: result.draft?.message || null } } };
  }
  if (tool === "orkestr_send_gmail_draft") {
    const result = await sendGmailDraft(args, env, fetchImpl, options);
    return { handled: true, result: { ok: true, provider: "gmail", draftId: result.draftId, message: result.message } };
  }
  if (tool === "orkestr_send_gmail_message") {
    const result = await sendGmailMessage(args, env, fetchImpl, options);
    return { handled: true, result: { ok: true, provider: "gmail", message: result.message } };
  }
  if (tool === "orkestr_list_google_calendar_events") {
    const result = await listGoogleCalendarEvents(args, env, fetchImpl, options);
    return {
      handled: true,
      result: {
        ok: true,
        provider: "google_calendar",
        calendarId: result.calendarId,
        events: result.events.map(publicCalendarEvent),
        nextPageToken: result.nextPageToken,
      },
    };
  }
  if (tool === "orkestr_create_google_calendar_event") {
    const result = await createGoogleCalendarEvent(args, env, fetchImpl, options);
    return { handled: true, result: { ok: true, provider: "google_calendar", action: "create", calendarId: result.calendarId, event: publicCalendarEvent(result.event) } };
  }
  if (tool === "orkestr_update_google_calendar_event") {
    const result = await updateGoogleCalendarEvent(args, env, fetchImpl, options);
    return { handled: true, result: { ok: true, provider: "google_calendar", action: "update", calendarId: result.calendarId, eventId: result.eventId, event: publicCalendarEvent(result.event) } };
  }
  if (tool === "orkestr_delete_google_calendar_event") {
    const result = await deleteGoogleCalendarEvent(args, env, fetchImpl, options);
    return { handled: true, result: { ok: true, provider: "google_calendar", action: "delete", calendarId: result.calendarId, eventId: result.eventId } };
  }
  if (tool === "orkestr_get_google_drive_file") {
    const result = await getGoogleDriveFile(args, env, fetchImpl, options);
    return {
      handled: true,
      result: {
        ok: true,
        provider: "google_drive",
        file: publicDriveFile(result.file),
        ...(result.content !== undefined ? { content: clean(result.content).slice(0, Number(args.maxChars) || 20_000) } : {}),
      },
    };
  }
  return { handled: false, result: null };
}
