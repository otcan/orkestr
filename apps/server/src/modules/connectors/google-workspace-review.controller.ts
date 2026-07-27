import { Body, Controller, Get, Param, Post, Query, Res } from "@nestjs/common";
import {
  createGmailDraft,
  createGoogleCalendarEvent,
  createGoogleWorkspaceConnectLink,
  listGoogleCalendarEvents,
  sendGmailMessage,
} from "../../../../../packages/connectors/src/google-workspace.js";
import { getGmailMessage, listGmailMessages } from "../../../../../packages/connectors/src/gmail.js";
import { listGoogleWorkspaceConnections } from "../../../../../packages/connectors/src/google-workspace-connections.js";
import { appendGoogleWorkspaceReviewAudit, listGoogleWorkspaceReviewAudit } from "../../../../../packages/connectors/src/google-workspace-review-audit.js";
import {
  googleWorkspaceReviewEnvironmentPath,
  verifyGoogleWorkspaceReviewEnvironmentTicket,
} from "../../../../../packages/connectors/src/google-workspace-review-environment.js";
import { userPrincipal } from "../../../../../packages/core/src/principal.js";
import { googleWorkspaceReviewPageHtml } from "./google-workspace-review-page.js";

function clean(value: unknown): string {
  return String(value || "").trim();
}

function reviewError(error: unknown): { statusCode: number; payload: Record<string, unknown> } {
  const source = error as { statusCode?: number; code?: string; message?: string };
  const statusCode = Number(source?.statusCode || 400) || 400;
  return {
    statusCode,
    payload: {
      ok: false,
      error: clean(source?.code || source?.message || "google_workspace_review_failed"),
    },
  };
}

function reviewContext(ticket: string) {
  const verified = verifyGoogleWorkspaceReviewEnvironmentTicket(ticket, {}, process.env);
  if (!verified.ok) {
    const error: any = new Error("google_workspace_review_environment_invalid_or_expired");
    error.statusCode = 403;
    error.code = error.message;
    throw error;
  }
  return {
    ticket,
    userId: verified.userId,
    threadId: verified.threadId,
    expiresAt: verified.expiresAt,
    principal: userPrincipal({ id: verified.userId, source: "google-oauth-review" }),
  };
}

async function operationOptions(context: ReturnType<typeof reviewContext>, value: Record<string, unknown> = {}) {
  const connectionId = clean(value.connectionId || value.accountId);
  const listed = await listGoogleWorkspaceConnections(process.env, {
    principal: context.principal,
    threadId: context.threadId,
    includeExplicit: true,
  });
  if (!listed.connections.length) {
    const error: any = new Error("google_workspace_not_connected");
    error.code = error.message;
    error.statusCode = 403;
    throw error;
  }
  if (connectionId && !listed.connections.some((connection: any) => connection.connectionId === connectionId)) {
    const error: any = new Error("connector_account_not_found");
    error.code = error.message;
    error.statusCode = 404;
    throw error;
  }
  return {
    principal: context.principal,
    threadId: context.threadId,
    connectionId,
  };
}

function reviewConnectUrl(link = "", ticket = "") {
  const raw = clean(link);
  if (!raw) return "";
  const parsed = new URL(raw, "http://reviewer.local");
  parsed.searchParams.set("review_environment", ticket);
  return /^https?:\/\//i.test(raw) ? parsed.toString() : `${parsed.pathname}${parsed.search}`;
}

function json(response: any, statusCode: number, payload: Record<string, unknown>) {
  return response.status(statusCode).header("cache-control", "no-store").json(payload);
}

function connectionState(connections: Array<Record<string, unknown>> = []) {
  if (!connections.length) return "disconnected";
  const health = connections.map((connection) => clean(connection.healthState));
  if (health.some((state) => ["reauth_required", "revoked"].includes(state))) return "expired";
  if (health.some((state) => !["", "connected"].includes(state))) return "failed";
  return "connected";
}

function auditOptions(context: ReturnType<typeof reviewContext>) {
  return { principal: context.principal };
}

async function audit(context: ReturnType<typeof reviewContext>, action: string) {
  await appendGoogleWorkspaceReviewAudit(action, process.env, auditOptions(context)).catch(() => null);
}

function publicMessage(message: Record<string, unknown> = {}) {
  return {
    id: clean(message.id),
    threadId: clean(message.threadId),
    from: clean(message.from),
    to: clean(message.to),
    subject: clean(message.subject),
    date: clean(message.date),
    snippet: clean(message.snippet),
    body: clean(message.body),
  };
}

function publicCalendarEvent(event: Record<string, any> = {}) {
  return {
    id: clean(event.id),
    summary: clean(event.summary),
    description: clean(event.description),
    location: clean(event.location),
    start: event.start || null,
    end: event.end || null,
    htmlLink: clean(event.htmlLink),
  };
}

@Controller("review/google")
export class GoogleWorkspaceReviewController {
  @Get(":ticket")
  open(@Param("ticket") ticket = "", @Res() response: any) {
    try {
      const context = reviewContext(ticket);
      response.setHeader("cache-control", "no-store");
      response.setHeader("referrer-policy", "no-referrer");
      return response
        .status(200)
        .type("text/html; charset=utf-8")
        .send(googleWorkspaceReviewPageHtml({ ticket: context.ticket, expiresAt: context.expiresAt }));
    } catch (error) {
      const failure = reviewError(error);
      response.setHeader("cache-control", "no-store");
      response.setHeader("referrer-policy", "no-referrer");
      return response
        .status(failure.statusCode)
        .type("text/html; charset=utf-8")
        .send("<!doctype html><title>Google Workspace review unavailable</title><p>Google Workspace review link is invalid or expired.</p>");
    }
  }

  @Get(":ticket/status")
  async status(@Param("ticket") ticket = "", @Res() response: any) {
    try {
      const context = reviewContext(ticket);
      const connections = await listGoogleWorkspaceConnections(process.env, {
        principal: context.principal,
        threadId: context.threadId,
        includeExplicit: true,
      });
      const actions = await listGoogleWorkspaceReviewAudit(process.env, auditOptions(context));
      return json(response, 200, {
        ok: true,
        expiresAt: context.expiresAt,
        connectionState: connectionState(connections.connections),
        actions,
        ...connections,
      });
    } catch (error) {
      const failure = reviewError(error);
      return json(response, failure.statusCode, failure.payload);
    }
  }

  @Post(":ticket/connect")
  async connect(@Param("ticket") ticket = "", @Res() response: any) {
    try {
      const context = reviewContext(ticket);
      const link = await createGoogleWorkspaceConnectLink({
        principal: context.principal,
        thread: { id: context.threadId, name: "Google Workspace reviewer" },
        reviewAccess: true,
      }, process.env);
      const connectUrl = reviewConnectUrl(link.reviewLink || link.connectLink, context.ticket);
      if (!connectUrl) throw new Error("google_workspace_review_connect_link_missing");
      await audit(context, "google_connect_requested");
      return json(response, 200, {
        ok: true,
        connectUrl,
        expiresAt: link.expiresAt,
        capabilities: link.capabilities || [],
      });
    } catch (error) {
      const failure = reviewError(error);
      return json(response, failure.statusCode, failure.payload);
    }
  }

  @Get(":ticket/gmail/messages")
  async listMessages(@Param("ticket") ticket = "", @Query() query: Record<string, unknown>, @Res() response: any) {
    try {
      const context = reviewContext(ticket);
      const result = await listGmailMessages({
        query: clean(query.query),
        maxResults: Math.max(1, Math.min(20, Number(query.maxResults) || 10)),
      }, process.env, fetch, await operationOptions(context, query));
      await audit(context, "gmail_messages_listed");
      return json(response, 200, { ok: true, messages: result.messages || [], nextPageToken: clean(result.nextPageToken) });
    } catch (error) {
      const failure = reviewError(error);
      return json(response, failure.statusCode, failure.payload);
    }
  }

  @Get(":ticket/gmail/messages/:messageId")
  async message(@Param("ticket") ticket = "", @Param("messageId") messageId = "", @Query() query: Record<string, unknown>, @Res() response: any) {
    try {
      const context = reviewContext(ticket);
      const message = await getGmailMessage(messageId, process.env, fetch, await operationOptions(context, query));
      await audit(context, "gmail_message_read");
      return json(response, 200, { ok: true, message: publicMessage(message) });
    } catch (error) {
      const failure = reviewError(error);
      return json(response, failure.statusCode, failure.payload);
    }
  }

  @Post(":ticket/gmail/drafts")
  async createDraft(@Param("ticket") ticket = "", @Body() body: Record<string, unknown> = {}, @Res() response: any) {
    try {
      const context = reviewContext(ticket);
      const result = await createGmailDraft({ to: clean(body.to), subject: clean(body.subject), body: clean(body.body) }, process.env, fetch, await operationOptions(context, body));
      await audit(context, "gmail_draft_created");
      return json(response, 201, { ok: true, draft: { id: clean(result.draft?.id), message: result.draft?.message || null } });
    } catch (error) {
      const failure = reviewError(error);
      return json(response, failure.statusCode, failure.payload);
    }
  }

  @Post(":ticket/gmail/messages")
  async sendMessage(@Param("ticket") ticket = "", @Body() body: Record<string, unknown> = {}, @Res() response: any) {
    try {
      if (body.confirmed !== true) {
        const error: any = new Error("google_workspace_review_send_confirmation_required");
        error.statusCode = 400;
        throw error;
      }
      const context = reviewContext(ticket);
      const result = await sendGmailMessage({ to: clean(body.to), subject: clean(body.subject), body: clean(body.body) }, process.env, fetch, await operationOptions(context, body));
      await audit(context, "gmail_message_sent");
      return json(response, 201, { ok: true, message: { id: clean(result.message?.id), threadId: clean(result.message?.threadId) } });
    } catch (error) {
      const failure = reviewError(error);
      return json(response, failure.statusCode, failure.payload);
    }
  }

  @Get(":ticket/calendar/events")
  async listEvents(@Param("ticket") ticket = "", @Query() query: Record<string, unknown>, @Res() response: any) {
    try {
      const context = reviewContext(ticket);
      const result = await listGoogleCalendarEvents({
        timeMin: clean(query.timeMin),
        timeMax: clean(query.timeMax),
        calendarId: clean(query.calendarId),
        maxResults: Math.max(1, Math.min(20, Number(query.maxResults) || 10)),
      }, process.env, fetch, await operationOptions(context, query));
      await audit(context, "calendar_events_listed");
      return json(response, 200, { ok: true, calendarId: result.calendarId, events: (result.events || []).map(publicCalendarEvent) });
    } catch (error) {
      const failure = reviewError(error);
      return json(response, failure.statusCode, failure.payload);
    }
  }

  @Post(":ticket/calendar/events")
  async createEvent(@Param("ticket") ticket = "", @Body() body: Record<string, unknown> = {}, @Res() response: any) {
    try {
      if (body.confirmed !== true) {
        const error: any = new Error("google_workspace_review_event_confirmation_required");
        error.statusCode = 400;
        throw error;
      }
      const context = reviewContext(ticket);
      const result = await createGoogleCalendarEvent({
        calendarId: clean(body.calendarId),
        summary: clean(body.summary),
        description: clean(body.description),
        startDateTime: clean(body.startDateTime),
        endDateTime: clean(body.endDateTime),
      }, process.env, fetch, await operationOptions(context, body));
      await audit(context, "calendar_event_created");
      return json(response, 201, { ok: true, calendarId: result.calendarId, event: publicCalendarEvent(result.event) });
    } catch (error) {
      const failure = reviewError(error);
      return json(response, failure.statusCode, failure.payload);
    }
  }
}
