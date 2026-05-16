# Changelog

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
- Local-first setup, connector status, and config persistence.
- Thread-first runtime API with wake, sleep, input, history, timers, and file upload endpoints.
- Agent templates, generic executor boundary, and private overlay loading.
- Gmail OAuth skeleton and mocked Gmail test coverage.
- WhatsApp bridge status, inbound routing, dedupe, and deterministic mock delivery tests.
- Dependency-free job-search demo covering the WhatsApp-to-agent-to-WhatsApp loop.

Known alpha boundaries:

- Real Codex runtime orchestration is environment-dependent and should be supplied through config or private overlay.
- Real WhatsApp Web sessions, browser profiles, OAuth tokens, hostnames, prompts, and personal timers must stay outside the public repo.
- Browser automation is represented by public registry/preparation surfaces; logged-in production profiles are private deployment data.
