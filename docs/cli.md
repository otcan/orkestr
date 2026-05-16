# Orkestr CLI

The public CLI is an API client for a local Orkestr daemon. It must not read
private deployment files, host-specific tmux state, or connector secrets
directly.

## Current commands

```bash
orkestr serve --open
orkestr list
orkestr thread create "My Thread" --cwd /path/to/repo
orkestr worker create otcanClaw-features --task "Investigate this in parallel"
orkestr worker create otcanClaw-features --blank
orkestr attach
orkestr attach <thread-name-or-id>
orkestr attach <thread-name-or-id> --print
orkestr send <thread-name-or-id> "Run the next step"
orkestr wake <thread-name-or-id>
orkestr sleep <thread-name-or-id>
```

`orkestr attach` without an argument fetches live threads and asks which thread
to attach to. This removes the old list-copy-attach workflow.

`orkestr thread create` creates a top-level Orkestr thread through the public API.
Useful flags are `--id`, `--cwd`, `--command`, `--executor`, and `--json`.

`orkestr worker create` creates a git worktree-backed worker from an existing
parent thread. Pass task text positionally or with `--task`; use `--blank` for a
parallel chat with no first message. Worker creation wakes the new worker by
default; pass `--no-wake` when scripting tests or preparing a worker offline.

Attach keeps the backing tmux session name stable, but names the tmux/byobu
window after the Orkestr thread on wake and attach. The current runtime model is
one Orkestr thread per tmux session; grouping multiple live thread panes into a
single byobu session would need a separate session/window mapping.

The API base defaults to `http://127.0.0.1:19812` and can be overridden with:

```bash
ORKESTR_API_BASE=http://127.0.0.1:19812 orkestr list
orkestr --api http://127.0.0.1:19812 list
```

## Industry-grade CLI roadmap

- Interactive selection: fuzzy thread picker, recent-thread ranking, keyboard
  navigation, and `--filter state=ready`.
- Output contracts: stable `--json`, predictable exit codes, and no mixed human
  text on stdout for machine-readable commands.
- Shell integration: completions for Bash/Zsh/Fish, config profiles, and
  aliases for frequently used threads.
- Attach UX: auto-wake prompt for sleeping threads, raw terminal fallback
  through WebSocket when local tmux is not available, and clear lease state.
- Safety: dry-run mode for destructive commands, confirmation prompts for
  sleep/recover/delete, and explicit `--force` semantics.
- Observability: `orkestr doctor`, `orkestr logs`, `orkestr events`, and
  per-thread timeline inspection.
- Packaging: publish an `orkestr` binary from the public package while keeping
  private overlays outside the repo.
- Extensibility: generated command schemas from the public API so web, CLI, and
  automation clients stay aligned.
