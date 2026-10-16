# Changelog

## 0.1.0-alpha.205

- WhatsApp "Message yourself" is read again: newer WhatsApp delivers your own self-chat messages on a hidden @lid id; Orkestr now maps it to your number. The agent's own replies echoed on that id are still recognised and never fed back as your input.
- One simple WhatsApp flow:
  - Setup → WhatsApp is two steps, "1. Link your phone" and "2. Chat in Message yourself"; a second number and separate chats per thread are under Advanced.
  - On a personal Docker install, linking WhatsApp connects Message yourself to your main thread automatically (only if the choice is unambiguous and nothing is bound yet; off for multi-user, brokered and tenant installs; `ORKESTR_WHATSAPP_AUTO_HOME_CHAT=1/0` overrides).
  - Thread settings → WhatsApp keeps the one-click Message yourself card on top; accounts and groups are under Advanced.
  - The thread header shows how the thread is reachable from WhatsApp, and chat messages are marked "from WhatsApp" / "sent to WhatsApp".

## 0.1.0-alpha.204

- Web chat updates live: a new or changed message (for example from WhatsApp) reaches open browsers within about a second; the server no longer serves a 15-second-old thread summary.
- Cleaner thread header: the Codex/Claude switch only appears when Claude Code is enabled on this server, usage pills only for agents with real data (no "5h ?"), "Default model" instead of "Syncing model", and less vertical space above the messages.
- WhatsApp reconnects after recreating the Docker container (a Chrome lock left by the old container no longer blocks Chrome: "Target closed"), and Connect after a logout shows a fresh QR instead of "auth failure". A QR from a failed or replaced runtime is never shown.
- Setup → WhatsApp: the page and the Message yourself panel refresh while you scan; a linked number shows only Unlink; the second number is optional and tucked away.
- Thread settings → WhatsApp: "Use my Message yourself chat" in one click, or how to reach the thread from it (`@name`, one word).
- WhatsApp routing: deleting a chat-level binding retires that binding (before, only its thread was retired and the route stayed live); disabled bindings route nothing.

## 0.1.0-alpha.203

- Phones: the conversation view gives the screen to the messages (on an iPhone it showed one line). One-row top bar with every item visible down to 320px, one-line thread header, compact tool tabs, and a composer with the text field on top and one button row.
- WhatsApp "Message yourself" is a home chat for several threads: `@name message` sends to another thread, `/switch name` keeps talking to it (`/switch` comes back), `/threads` lists them, and replying to a `[name] …` message answers that thread. Only your own messages are routed, and only to your threads that have no WhatsApp chat of their own.
- Setup → WhatsApp: connect "Message yourself" to a thread after the first run; with a second linked number, give a thread its own chat.
- Setup → WhatsApp no longer shows a linked account as "idle"; rows are WhatsApp 1/2 with the linked number.

## 0.1.0-alpha.202

- First run: no "Name and start" step. As soon as Codex or Claude Code is signed in, Orkestr creates the first conversation `orkestr` and opens it.
- Identity-provider installs (Keycloak) never ask for an owner username/password.
- First-visit owner setup stays open until a pairing challenge is approved or a browser session exists; an unused challenge (for example from a stale tab) no longer closes it.
- WhatsApp setup works with the owner login (fixes "whatsapp_bridge_token_unconfigured"); browser access to the WhatsApp bridge is admin-only.
- Desktop viewer opens in Docker (fixes `unsupported_browserctl_command`).
- Settings works on standalone installs (a local instance identity is created on first use; fixes `instance_identity_required`).
- Replies show up faster: a busy open conversation refreshes every 1.5 seconds.
- Desktops page copy no longer mentions LinkedIn.

## 0.1.0-alpha.201

- Security fix for 0.1.0-alpha.200: anonymous first-visit owner setup is only open on a fresh install (no owner, never paired or signed in, browser-pairing auth). On existing installs a signed-in admin creates the login. Do not use 0.1.0-alpha.200 on an install that already used browser pairing or an identity provider.

## 0.1.0-alpha.200

- Owner login: the first visit asks for a username and password (no `docker exec … approve`); the browser then holds a signed JWT (HS256, random per-install key in `ORKESTR_HOME`, HttpOnly cookie, 30 days). Once a login exists, sign-in is required; local installs can choose "Later". Wrong passwords are limited to 10 per 15 minutes; changing the password signs out old tokens. The vault, Log out and opening desktops work with this login. Browser pairing remains for approval links and as "Approve this browser with a command instead"; `ORKESTR_OWNER_LOGIN_PROMPT=0` keeps the old pairing-first flow.
- `http://0.0.0.0:…` redirects to `http://localhost:…` (a secure page for browsers); README uses `-p 127.0.0.1:3000:3000` and `http://localhost:3000`.
- Copy buttons work on any page (fallback when the Clipboard API is unavailable).
- Encrypted attachments work on insecure pages (age-encryption uses its pure-JS fallback instead of failing with "Protected attachment setup is retrying").
- Desktops page answers from the last known list and refreshes in the background.
- Docker starts with one desktop instead of three; desktops open with the owner login (no `oidc_desktop_session_required`).
- Images for amd64 and arm64 (Apple Silicon) under one tag.

## 0.1.0-alpha.199

- Fast start from a fresh clone: `npm ci` no longer downloads puppeteer's ~650 MB Chrome (WhatsApp uses the installed Chrome or Chromium, or `WA_CHROME_PATH`; `ORKESTR_DOWNLOAD_CHROME=1` restores the download), and `npm start` builds the server once if needed. README starts with the real app; shell blocks have no `#` comments.
- No entry without a coding agent: until Codex or a Claude Code account is ready, the app shows only the first-run wizard (no Close); non-admins see an explanation. Setup, pairing and connector sign-in pages stay reachable.
- No demo conversations: the `orkestr demo` simulation is removed, the thread API refuses the no-op/simulated test executors (`ORKESTR_ALLOW_TEST_EXECUTORS=1` for the test runner), and the "orkestr-watcher" alert thread is no longer created on its own (`ORKESTR_WATCHER_AUTO_CREATE=1` to opt in; alerts are still recorded).
- The Connections page is gone from the navigation: connectors are enabled in Setup (top bar "Setup"); `/connectors/<id>` sign-in links keep working.
- Files opens on "Agent workspaces" (each conversation's folder) next to "Shared files", with explanations and useful empty states.
- Vault on an install without sign-in explains why it is locked and links to Setup → Security instead of showing `vault_owner_session_required`.
- "Copy link" removed. "Log out" only appears when the install has a sign-in; otherwise the menu says why there is none.
- WhatsApp group picture audit: strict CLI parsing and an explicit `allGroups` request (from the stale-branch integration).

## 0.1.0-alpha.198

- One first-run path: a new install opens a three-step wizard (Link WhatsApp → Choose the AI → Name and start) at `/` and at a bare `/setup`. The long setup page is now Setup only (no goals, step tabs or starter thread); the timezone moved into Setup → Connections.
- Codex sign-in happens inside the wizard with a ChatGPT device code (shared `ork-codex-sign-in-panel`, also used by Setup and the compact `?compact=1` link). Only admins see it.
- Leaving Setup from the wizard returns to the same step. Existing installs with an expired Codex login are no longer redirected from `/` to Setup; they see the Codex notice instead. `ORKESTR_ONBOARDING_AUTO_OPEN=0` still turns first-run auto-open off.
- Pairing page: plain explanation, the `docker exec` form of the approve command on Docker installs, expiry countdown and "Make a new code".
- WhatsApp: own media echoes are recognised by message id (waiting for in-flight sends) and dropped before download; a real self-chat photo during a send is kept. The connector gateway delivers each inbox event once (single flight + lease), and routing for one event id runs in sequence.

## 0.1.0-alpha.47

- Deliver Gmail notification rules as out-of-band ChatUI/WhatsApp notifications by default, instead of queuing them as Codex thread input.
- Keep generic connector prompt pushes on their existing queued prompt path, with an explicit delivery mode for notification-style pushes.

## 0.1.0-alpha.21

- Mirror all Codex assistant updates to WhatsApp: generic commentary, progress updates, approval prompts, plans, and final answers now all reach the bound WhatsApp chat instead of being filtered to only selected "user-facing" updates.
- Remove WhatsApp progress throttling and latest-only suppression so every assistant update is delivered in order.

## 0.1.0-alpha.20

- Guard native Codex approval flow: YOLO threads auto-accept command/file approval requests, stale approval prompts are cleared, and `/approve` from WhatsApp is handled locally when no actionable Codex approval is pending.
- Hide web approval controls unless the selected app-server thread is actually awaiting approval.
- Add a sidebar "Read all" action for clearing loaded Orkestr thread unread state.
- Improve tenant connector setup from WhatsApp: user-owned Gmail sign-in, scoped Gmail tools for API agents, parent app credentials, and shared Google OAuth callback routing.
- Harden WhatsApp routing: atomic inbound event dedupe, tenant reply recovery, stale frame recovery, typing lifecycle fixes, and filtered progress mirroring so internal commentary is not sent to WhatsApp.
- Improve native Codex app-server turn handling: local mode commands, imported final cleanup, active status normalization, stale API-agent recovery, and safer release restarts that reap service child processes.
- Add public OAuth broker support and use neutral example domains in docs and installer defaults.

## 0.1.0-alpha.5

- Remove a live-looking tailnet hostname from public WhatsApp test fixtures.
- Re-run the public launch gate, including privacy scan, full test suite, smoke test, and demo.

## 0.1.0-alpha.4

- Parse owner `/now` and `/interrupt` commands at the Orkestr thread input boundary so Codex never receives them as literal slash commands.
- Return queued interrupt metadata so WhatsApp routing can track interrupt delivery instead of assuming synchronous injection.
- Add a regression test for stripping `/now` before runtime delivery.

## 0.1.0-alpha.3

- Normalize legacy timer records that still use `dueAt`, `text`, and `repeat` fields so they can fire under the new OSS scheduler.
- Deliver due timers independently so one broken timer target cannot block later timers or mark them as run before delivery.
- Keep failed timer records due and record `timer_due_failed` events instead of silently advancing them.
- Automatically accept Codex's resume-directory prompt during runtime wake so hibernated timers can reach the Codex prompt.

## 0.1.0-alpha.2

- Keep Raw terminal access inside the Angular thread cockpit instead of opening a separate window.
- Fix chat auto-scroll so it follows new messages only while the user is already at the bottom.
- Hide Wake, Sleep, and Recover controls unless the selected thread is eligible for that action.
- Add an Ops cockpit panel for connectors, agents, timers, browsers, runtime leases, events, and WhatsApp status.
- Restyle the Angular UI with a denser terminal-oriented visual language.

## 0.1.0-alpha.1

- Fix Angular thread UI repaint after async API loads so `/ng/thread/<name>` shows the thread sidebar and selected conversation immediately.

## 0.1.0-alpha.0

Initial public alpha baseline.

- NestJS API serving the Angular web app.
- Self-hosted setup, connector status, and config persistence.
- Thread-first runtime API with wake, sleep, input, history, timers, and file upload endpoints.
- Agent templates, generic executor boundary, and private overlay loading.
- Gmail OAuth skeleton and mocked Gmail test coverage.
- WhatsApp bridge status, inbound routing, dedupe, and deterministic mock delivery tests.
- Dependency-free job-search demo covering the WhatsApp-to-agent-to-WhatsApp loop.

Known alpha boundaries:

- Real Codex runtime orchestration is environment-dependent and should be supplied through config or private overlay.
- Real WhatsApp Web sessions, browser profiles, OAuth tokens, hostnames, prompts, and personal timers must stay outside the public repo.
- Browser automation is represented by public registry/preparation surfaces; logged-in production profiles are private deployment data.
