import { BadRequestException, Body, Controller, ForbiddenException, Get, Param, Post, Req, Res } from "@nestjs/common";
import {
  approvePairingChallenge,
  createPairingChallenge,
  pairBrowser,
  sessionCookieHeader,
} from "../../../../../packages/core/src/security.js";
import {
  googleWorkspaceReviewEnvironmentIdentity,
  googleWorkspaceReviewEnvironmentEnabled,
  verifyGoogleWorkspaceReviewPassword,
} from "../../../../../packages/connectors/src/google-workspace-review-environment.js";
import { appendGoogleWorkspaceReviewAudit, listGoogleWorkspaceReviewAudit } from "../../../../../packages/connectors/src/google-workspace-review-audit.js";
import { listGoogleWorkspaceConnections } from "../../../../../packages/connectors/src/google-workspace-connections.js";
import { createGoogleCalendarEvent, createGmailDraft, listGoogleCalendarEvents, sendGmailMessage } from "../../../../../packages/connectors/src/google-workspace.js";
import { getGmailMessage, listGmailMessages } from "../../../../../packages/connectors/src/gmail.js";
import { requestPrincipal } from "../../../../../packages/core/src/principal.js";
import { googleWorkspaceReviewLoginPageHtml } from "./google-workspace-review-page.js";
import { googleWorkspaceReviewActionsPageHtml } from "./google-workspace-review-actions-page.js";
import { googleWorkspaceReviewDemoPageHtml } from "./google-workspace-review-demo-page.js";

function clean(value: unknown): string {
  return String(value || "").trim();
}

function reviewerResponseHeaders(response: any) {
  response.setHeader("cache-control", "no-store");
  response.setHeader("referrer-policy", "no-referrer");
}

function requestIp(request: any): string {
  return clean(request?.ip || request?.socket?.remoteAddress || request?.connection?.remoteAddress).replace(/^::ffff:/, "");
}

function reviewMessage(message: any = {}) {
  return {
    id: clean(message.id),
    subject: clean(message.subject),
    from: clean(message.from),
    to: clean(message.to),
    date: clean(message.date),
    preview: clean(message.text || message.snippet).slice(0, 500),
  };
}

@Controller("review/google")
export class GoogleWorkspaceReviewController {
  private reviewPrincipal(request: any) {
    const principal = requestPrincipal(request);
    const identity = googleWorkspaceReviewEnvironmentIdentity(process.env);
    if (!googleWorkspaceReviewEnvironmentEnabled(process.env) || clean(principal.userId || principal.id) !== identity.userId) {
      throw new ForbiddenException("google_workspace_reviewer_access_required");
    }
    return principal;
  }

  private async reviewConnection(request: any) {
    const principal = this.reviewPrincipal(request);
    const listed = await listGoogleWorkspaceConnections(process.env, { principal, includeExplicit: true });
    const connection = listed.connections.find((candidate: any) => clean(candidate.email) && clean(candidate.connectionId));
    if (!connection) throw new BadRequestException("google_workspace_reviewer_connection_required");
    return { principal, connection };
  }

  @Get()
  entry(@Req() request: any, @Res() response: any) {
    reviewerResponseHeaders(response);
    if (request?.orkestrSecuritySession) return response.redirect(302, "/review/google/demo");
    return response.status(200).type("text/html; charset=utf-8").send(googleWorkspaceReviewLoginPageHtml());
  }

  @Post("session")
  async createSession(@Body() body: Record<string, unknown> = {}, @Req() request: any, @Res() response: any) {
    reviewerResponseHeaders(response);
    if (!verifyGoogleWorkspaceReviewPassword(clean(body.password), process.env)) {
      return response.status(403).type("text/html; charset=utf-8").send(googleWorkspaceReviewLoginPageHtml({ error: "Unable to sign in." }));
    }
    try {
      const identity = googleWorkspaceReviewEnvironmentIdentity(process.env);
      // This route is enabled only on a disposable reviewer VM. A normal Orkestr
      // installation continues to use browser pairing and cannot use this password.
      const challenge = await createPairingChallenge({
        request,
        userId: identity.userId,
        role: "admin",
        requestedPath: "/review/google/demo",
      } as any);
      await approvePairingChallenge(challenge.challengeId, { approvedBy: "google_review_password" });
      const paired = await pairBrowser({
        challengeId: challenge.challengeId,
        userAgent: clean(request?.headers?.["user-agent"]),
        ip: requestIp(request),
        allowApproveCode: false,
      } as any);
      response.setHeader("set-cookie", sessionCookieHeader(paired.token, process.env, {
        requestHost: clean(request?.headers?.["x-forwarded-host"] || request?.headers?.host),
        path: "/",
      }));
      return response.redirect(303, "/review/google/demo");
    } catch {
      return response.status(503).type("text/html; charset=utf-8").send(googleWorkspaceReviewLoginPageHtml({
        error: "Unable to open the reviewer environment. Try again shortly.",
      }));
    }
  }

  @Get("session")
  oldSession(@Res() response: any) {
    reviewerResponseHeaders(response);
    return response.redirect(302, "/review/google");
  }

  @Get("demo")
  demo(@Req() request: any, @Res() response: any) {
    this.reviewPrincipal(request);
    reviewerResponseHeaders(response);
    return response.status(200).type("text/html; charset=utf-8").send(googleWorkspaceReviewDemoPageHtml({
      connected: clean(request?.query?.connected) === "1",
    }));
  }

  @Post("demo/api/chat")
  demoChat(@Body() body: Record<string, unknown> = {}, @Req() request: any) {
    this.reviewPrincipal(request);
    const message = clean(body.message).slice(0, 1000);
    if (!message) throw new BadRequestException("workspace_chat_message_required");
    const wantsGoogle = /\b(google|gmail|calendar|connect|oauth)\b/i.test(message);
    if (wantsGoogle) {
      return {
        ok: true,
        message: "I prepared a secure Google Workspace connection link for this client workspace. After the account owner approves it, the selected Gmail and Calendar capabilities can be used directly in chat or by this thread's timers.",
        action: { label: "Continue to Google", href: "/connectors/gmail" },
      };
    }
    return {
      ok: true,
      message: "I can keep that work in this thread and attach a timer when it needs follow-through. Ask me to create a Google connection link when the account owner is ready to approve Gmail and Calendar capabilities.",
    };
  }

  @Get("actions")
  actions(@Req() request: any, @Res() response: any) {
    this.reviewPrincipal(request);
    reviewerResponseHeaders(response);
    return response.status(200).type("text/html; charset=utf-8").send(googleWorkspaceReviewActionsPageHtml());
  }

  @Get("actions/api/status")
  async actionStatus(@Req() request: any) {
    const principal = this.reviewPrincipal(request);
    const listed = await listGoogleWorkspaceConnections(process.env, { principal, includeExplicit: true });
    const connection = listed.connections.find((candidate: any) => clean(candidate.email) && clean(candidate.connectionId));
    return {
      ok: true,
      connected: Boolean(connection),
      account: connection ? {
        email: clean(connection.email),
        capabilities: Array.isArray(connection.capabilities) ? connection.capabilities : [],
      } : null,
      audit: await listGoogleWorkspaceReviewAudit(process.env, { principal }),
    };
  }

  @Post("actions/api/gmail-read")
  async readGmail(@Req() request: any) {
    const { principal, connection } = await this.reviewConnection(request);
    const listed = await listGmailMessages({
      maxResults: 1,
      query: 'from:me subject:"Orkestr Google OAuth review"',
    }, process.env, fetch, { principal, connectionId: connection.connectionId });
    const messageId = clean(listed.messages?.[0]?.id);
    const message = messageId
      ? await getGmailMessage(messageId, process.env, fetch, { principal, connectionId: connection.connectionId })
      : null;
    await appendGoogleWorkspaceReviewAudit("gmail_messages_listed", process.env, { principal });
    if (message) await appendGoogleWorkspaceReviewAudit("gmail_message_read", process.env, { principal });
    return { ok: true, action: "gmail_read", message: message ? reviewMessage(message) : null };
  }

  @Post("actions/api/gmail-draft")
  async createDraft(@Req() request: any) {
    const { principal, connection } = await this.reviewConnection(request);
    const draft = await createGmailDraft({
      to: connection.email,
      subject: "Orkestr Google OAuth review draft",
      body: "This draft was created by the isolated Orkestr Google Workspace reviewer environment.",
    }, process.env, fetch, { principal, connectionId: connection.connectionId });
    await appendGoogleWorkspaceReviewAudit("gmail_draft_created", process.env, { principal });
    return { ok: true, action: "gmail_drafts", draftId: clean(draft.draft?.id), recipient: clean(connection.email) };
  }

  @Post("actions/api/gmail-send")
  async sendGmail(@Req() request: any) {
    const { principal, connection } = await this.reviewConnection(request);
    const sent = await sendGmailMessage({
      to: connection.email,
      subject: "Orkestr Google OAuth review test message",
      body: "This message was sent by the isolated Orkestr Google Workspace reviewer environment.",
    }, process.env, fetch, { principal, connectionId: connection.connectionId });
    await appendGoogleWorkspaceReviewAudit("gmail_message_sent", process.env, { principal });
    return { ok: true, action: "gmail_send", messageId: clean(sent.message?.id), recipient: clean(connection.email) };
  }

  @Post("actions/api/calendar-list")
  async listCalendar(@Req() request: any) {
    const { principal, connection } = await this.reviewConnection(request);
    const now = new Date();
    const nextWeek = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const listed = await listGoogleCalendarEvents({
      calendarId: "primary",
      timeMin: now.toISOString(),
      timeMax: nextWeek.toISOString(),
      q: "Orkestr Google OAuth review",
      maxResults: 5,
    }, process.env, fetch, { principal, connectionId: connection.connectionId });
    await appendGoogleWorkspaceReviewAudit("calendar_events_listed", process.env, { principal });
    return {
      ok: true,
      action: "calendar_read",
      events: listed.events.map((event: any) => ({ id: clean(event.id), summary: clean(event.summary), start: event.start || null, end: event.end || null })),
    };
  }

  @Post("actions/api/calendar-create")
  async createCalendarEvent(@Req() request: any) {
    const { principal, connection } = await this.reviewConnection(request);
    const start = new Date(Date.now() + 60 * 60 * 1000);
    const end = new Date(start.getTime() + 30 * 60 * 1000);
    const created = await createGoogleCalendarEvent({
      calendarId: "primary",
      summary: "Orkestr Google OAuth review event",
      description: "Created by the isolated Orkestr Google Workspace reviewer environment.",
      startDateTime: start.toISOString(),
      endDateTime: end.toISOString(),
      timeZone: "UTC",
      sendUpdates: "none",
    }, process.env, fetch, { principal, connectionId: connection.connectionId });
    await appendGoogleWorkspaceReviewAudit("calendar_event_created", process.env, { principal });
    return {
      ok: true,
      action: "calendar_actions",
      event: { id: clean(created.event?.id), summary: clean(created.event?.summary), start: created.event?.start || null, end: created.event?.end || null, htmlLink: clean(created.event?.htmlLink) },
    };
  }

  @Get(":legacy")
  oldTicket(@Param("legacy") _legacy: string, @Res() response: any) {
    reviewerResponseHeaders(response);
    return response.redirect(302, "/review/google");
  }
}
