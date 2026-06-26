# Architecture Diagram

Orkestr is a local-first control surface around Codex and user-owned
connectors. The public OSS repo contains generic runtime code and public-safe
examples only; private overlays, connector state, browser profiles, and secrets
belong outside the repo.

```mermaid
flowchart LR
  User[User browser, CLI, or phone] --> UI[Orkestr Web UI and CLI]
  UI --> API[NestJS API bound to localhost by default]
  API --> Setup[Setup wizard]
  API --> Threads[Thread runtime]
  Threads --> Codex[Codex CLI or app-server session]
  API --> Store[(ORKESTR_HOME state)]
  API --> Timers[Timers and watchers]
  API --> Desktops[Managed browser desktops]
  API --> Connectors[Optional connectors]
  Connectors --> Gmail[Gmail]
  Connectors --> WhatsApp[WhatsApp bridge or relay]
  Desktops --> LinkedIn[LinkedIn virtual browser]
  Timers --> Threads
  UI --> Remote[Protected remote access]
  Remote --> Tailnet[Tailscale, Caddy/TLS, or VPN]
```

## Boundary

- Orkestr runs and supervises agents.
- Codex remains the coding agent.
- Connectors are optional capabilities owned by the operator.
- oXRM is a separate workflow app that gives agents relationship state.
- Cross-project integration should use MCP/API contracts, not private package
  coupling.

