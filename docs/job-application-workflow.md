# Job Application And Outreach Workflow

Orkestr's public job-application workflow does not need Gmail inbox-read,
Gmail draft, Gmail watcher, or Google Calendar API access.

It is built from four user-controlled primitives:

1. A private inbound address per Jobs thread for job-board alerts.
2. The existing Jobs queue, which deduplicates and classifies an alert before
   recording a passive thread signal.
3. Orkestr-owned outbound email drafts, sent only through the install's SMTP or
   Microsoft Graph mail configuration after an explicit user action.
4. Standard `.ics` files and Google Calendar prefill links. The user reviews
   and saves the event in their calendar; Orkestr does not read or modify a
   Google calendar.

This keeps the main Job Application and LinkedIn outreach workflow usable on a
new self-hosted install without restricted Google OAuth scopes or a Google
mailbox token.

## User Flow

Open **Jobs** in the Orkestr cockpit and choose the thread that should receive
job opportunities. Select **Create address**. Orkestr creates a unique address
such as:

```text
jobs+<random-route-token>@alerts.example.com
```

Use that address directly when creating LinkedIn, job-board, recruiter, or ATS
alerts. If a source cannot send to a custom address, forward only a dedicated
Jobs label from the user's mailbox to that address. Do not forward a whole
mailbox.

Each received message is deduplicated by its provider message id (or a stable
content fingerprint), filtered, and classified. A matching result is recorded
as a passive Jobs signal in the selected thread. Inbound email does not create
or interrupt a Codex turn, and the raw email body is not injected as an agent
prompt.

Use the **Test** action after configuring the relay. It creates a synthetic job
alert and confirms the complete routing path without needing a real mailbox.

## Host Configuration

The host needs a domain that can receive mail and a relay that can POST a small,
normalized payload to Orkestr. Add these values to the private host environment,
never to the repository:

```dotenv
ORKESTR_JOB_ALERT_INBOUND_DOMAIN=alerts.example.com
ORKESTR_JOB_ALERT_RELAY_TOKEN=<long-random-secret>
```

The relay calls this endpoint:

```text
POST /api/jobs/inbound-email
Authorization: Bearer <ORKESTR_JOB_ALERT_RELAY_TOKEN>
Content-Type: application/json
```

Payload contract:

```json
{
  "to": "jobs+<random-route-token>@alerts.example.com",
  "from": "alerts@jobs.example",
  "subject": "New Product Engineer role",
  "text": "Plain-text alert body and job link",
  "messageId": "provider-stable-message-id",
  "receivedAt": "2026-08-04T12:00:00Z"
}
```

Use an adapter under your control when the mail provider cannot set an
`Authorization` header itself. The relay token is an ingress credential: it is
not shown in the web UI, must be stored only in the relay and Orkestr service
environment, and must be rotated after suspected exposure. Requests without a
valid token are rejected even when Orkestr is locally unpaired.

The address domain enables route creation. The relay token enables delivery.
The Jobs screen reports those two states separately so a generated address is
not mistaken for a working mail server.

## Outreach Drafts

The Jobs screen creates an **Orkestr draft**, not a Gmail draft. It stores the
recipient, subject, and body in the local Orkestr home and sends only after the
user selects **Send**. Delivery uses the configured `ORKESTR_MAIL_PROVIDER`
(`smtp` by default, or `graph` when configured).

This intentionally separates a draft from a mailbox provider's draft folder.
It keeps the public workflow free of `gmail.compose`; it also means the draft
will not appear in Gmail's Drafts folder unless a separate, privately reviewed
Google integration is enabled.

## Follow-ups And Calendar

Use **Automations** to create the follow-up timer for the same thread. Timers
remain normal Orkestr timers and can wake the thread at the requested time.

Use the Jobs calendar form to prepare an event. It returns both:

- a standard `.ics` download for any calendar app
- a Google Calendar `TEMPLATE` URL containing the proposed event

Opening the Google Calendar URL and saving it is the user's confirmation. No
Google sign-in, calendar read, or calendar-write API token is required by
Orkestr for this path.

## Scope Boundary

The public Google OAuth profile remains `gmail.send` only when a deployment
chooses to use Gmail as its outbound provider. The job-alert, draft, timer, and
calendar-export workflow requires no Google OAuth grant at all.

Restricted Gmail read, compose, modify, or notification features are not part
of this public workflow. Keep any experimentation with those capabilities on a
separate private development client and do not enable them on the public OAuth
client without the required Google security assessment and review.
