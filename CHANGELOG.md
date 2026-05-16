# Changelog

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
