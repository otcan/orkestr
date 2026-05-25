# Architecture

Orkestr is a self-hosted agent workstation monorepo with a small API server, a web cockpit, a CLI, and reusable packages.

```mermaid
flowchart TB
  subgraph Clients
    Web[Angular web UI]
    CLI[orkestr CLI]
    WA[WhatsApp user]
  end

  subgraph Server
    API[NestJS API]
    Setup[Setup and connector status]
    Threads[Thread runtime controller]
    Timers[Timer scheduler]
    BrowserAPI[Virtual browser API]
  end

  subgraph LocalRuntime
    Bridge[Built-in WhatsApp bridge]
    Tmux[tmux session lease]
    Codex[Codex CLI]
    Chrome[Chrome browser profiles]
  end

  subgraph Storage
    Home[(ORKESTR_HOME)]
    Overlay[ORKESTR_OVERLAY_DIR]
  end

  Web --> API
  CLI --> API
  WA --> Bridge --> API
  API --> Setup
  API --> Threads
  API --> Timers
  API --> BrowserAPI
  Threads --> Tmux --> Codex
  BrowserAPI --> Chrome
  API --> Home
  API -. optional .-> Overlay
```

## Runtime Boundary

The public API stores thread state, messages, connector status, timers, and browser profile metadata under `ORKESTR_HOME`.

Codex execution is intentionally local. The thread runtime wakes a tmux session and starts Codex in the thread workspace. Private deployments can customize launch behavior through environment variables or overlays, but the public repo must not contain private host assumptions.

## Deployment Boundary

Local and VPS deployments use host-native processes. A VPS should use the
systemd installer so Caddy, Tailscale, browser desktops, logs, and pairing
approval stay on the host where operators expect them.

## Connector Boundary

The public connector surface contains generic setup and routing code. Real credentials and session state stay outside the repo:

- Gmail tokens go under `ORKESTR_HOME/secrets`.
- WhatsApp Web session data stays under `ORKESTR_HOME`.
- Browser profiles stay under `ORKESTR_HOME/browsers`.
- Host-specific bindings live in private overlays.

## Web Routes

- `/setup` opens the setup dashboard for secure access, accounts, runtimes, and connectors.
- `/thread/:id` opens a thread.
- `/ops` opens system tools.
- Legacy `/ng/*` paths are accepted for compatibility while public docs use clean paths.
