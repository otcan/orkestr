# Orkestr CLI

The public CLI is an API client for a local Orkestr daemon. It must not read
private deployment files, host-specific tmux state, or connector secrets
directly.

## Current commands

```bash
orkestr serve --open
orkestr list
orkestr attach
orkestr attach <thread-name-or-id>
orkestr attach <thread-name-or-id> --print
orkestr send <thread-name-or-id> "Run the next step"
orkestr wake <thread-name-or-id>
orkestr sleep <thread-name-or-id>
```

`orkestr attach` without an argument fetches live threads and asks which thread
to attach to. This removes the old list-copy-attach workflow.

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
