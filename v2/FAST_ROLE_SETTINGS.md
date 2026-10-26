# Codex Fast model preferences

An owner can select a model and reasoning effort for a conversation's Codex Fast
role without changing Deep or Workers. This only selects next-turn parameters;
it does not admit an input, start a run, change the provider or reset native history.

`GET /api/v2/conversations/{id}/fast/settings` returns the current revision,
model and reasoning effort. Revision zero with null values means unchanged native
defaults. `PUT` fully replaces the Fast preference, using a separate optimistic
revision:

```json
{"expected_revision":0,"model":"gpt-6-luna","reasoning_effort":"low"}
```

A repeat with the same values and preceding revision is idempotent. Other stale
updates return `fast_settings_revision_mismatch`. Unknown fields and malformed or
policy-denied models are rejected. Existing owner authentication and browser CSRF
requirements apply; foreign conversations remain inaccessible.

The selection is frozen inside the Fast dispatch consumption transaction. A
running turn retains its original parameters. Deep and Worker launch settings,
conversation settings revisions and provider generations remain unchanged.
Both values null
clear the override. With no override (or one value unset) a Codex Fast turn
uses `gpt-6-luna` at `low` effort, never the native's global default; the host
Fast native also starts with those thread defaults. Claude Fast uses the
`sonnet` model at `low` effort. Codex-specific preferences cannot be set for a Claude
conversation; if its provider later changes to Claude, stored Codex Fast
preferences do not apply. Availability and actual model latency depend on the
configured Codex account and must be verified separately.

## Fast is read-only

Fast runs in parallel with Deep on the same input, so a Fast side effect would
happen twice. Fast is therefore read-only on every instance, including one with
host full access:

- Runtime requests, and requires the provider to confirm, the Codex
  `read-only` sandbox (network off) for every Fast thread
  (`CodexRpc::for_role`). The broker independently refuses any other sandbox for
  a Fast identity (`protocol.FAST_SANDBOX`), and the dedicated Fast broker
  serves only Fast identities.
- The host Fast native runs with its own `CODEX_HOME`, under the service
  user's home (`~/.local/state/orkestr-v2/fast-codex-home-<id>`, 0700), never
  inside a native state root (`private_state` refuses unknown entries there)
  or the operator's Codex home. It holds only a private 0600 copy of the
  operator's `auth.json`, synced before every launch (the newer side wins, so a
  token Fast's native refreshed is written back): no `config.toml`,
  exec-policy rules, hooks or plugins. With no config.toml no project is
  trusted, so a workspace's `.codex` config, rules and MCP servers stay
  disabled. The broker refuses to launch Fast if an `allow` rule or an operator
  layer under `/etc/codex` is still reachable. Apps/connectors, plugins, hooks,
  browser and desktop control, sub-agents, memories, goals, worktrees and
  dependency installs are also disabled (`codex_service/profile.py`).
- A Claude Fast session gets only `Read`, `Grep`, `Glob` and `WebSearch`, no MCP
  server, no settings sources and no hooks (`claude_connector.FAST_TOOLS`).
- Every Fast turn starts with the reply contract `FAST_TURN_NOTE`
  (`orkestr-runtime/src/execution.rs`): acknowledge and restate, answer only
  from the message or history, never claim anything was done, never treat a bug
  report as user error, open listed attachments, short and in the owner's
  language.
- The binding's chat rules are inlined into a Fast turn only when the adapter's
  own leading line names them (first line, followed by the adapter's source
  header), the file matches that line's version, is at most 20 KiB and is
  writable only by its owner, and the whole Fast input (with handoff context
  and digest) still fits the 32 KiB turn bound
  (`store-sqlite/src/production_runtime/fast_rules.rs`). Otherwise Fast keeps
  the line. Deep always keeps the line.
