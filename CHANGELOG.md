# Changelog

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
