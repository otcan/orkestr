# Pruning Codex app-server daemon releases

The Codex CLI's app-server daemon auto-updates itself and keeps every release it
has ever downloaded:

```text
$CODEX_HOME/packages/app-server-daemon/
  auto-update-version        # version the updater last installed
  current -> releases/<version>-<target>
  install.lock               # held by the updater while it installs
  releases/
    0.157.0-x86_64-unknown-linux-musl/
    ...
    0.162.1-x86_64-unknown-linux-musl/
```

Each release is a few hundred MB, so a long-running host builds up gigabytes
of old releases. Codex never removes them, and **Orkestr doesn't either**:
`CODEX_HOME` belongs to the Codex CLI login of the service user, outside
`ORKESTR_HOME`, and Orkestr code never deletes files outside `ORKESTR_HOME`.
Pruning is a manual operator task.

## What is safe to delete

- Keep the release that `current` points to.
- Keep the newest release before it, so you can roll back to it if the new
  daemon misbehaves.
- Keep any release that a running process still runs from. A Codex app-server
  started before an auto-update keeps running from the old directory until it
  restarts.
- Everything else under `releases/` can go. Don't touch `current`,
  `auto-update-version`, `install.lock` or anything outside `releases/`.

## Procedure

Run it as the user that owns `CODEX_HOME` (the Orkestr service user), not as
root, so file ownership stays the same. Do a dry run first by replacing
`rm -rf` with `echo`.

```sh
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
DAEMON="$CODEX_HOME/packages/app-server-daemon"
cd "$DAEMON/releases" || exit 1

current="$(basename "$(readlink -f "$DAEMON/current")")"
previous="$(ls -1 | sort -V | grep -vxF "$current" | tail -n 1)"
# Releases that running processes still use.
in_use="$(ls -l /proc/[0-9]*/exe 2>/dev/null | grep -o "$DAEMON/releases/[^/]*" | xargs -r -n1 basename | sort -u)"

# Hold the updater's lock so an auto-update can't run in the middle.
flock "$DAEMON/install.lock" sh -c '
  for release in *; do
    case "$release" in "$1"|"$2") continue ;; esac
    if printf "%s\n" "$3" | grep -qxF "$release"; then continue; fi
    rm -rf -- "./$release"
  done
' prune "$current" "$previous" "$in_use"
```

Afterwards, check `readlink -f "$DAEMON/current"` still resolves and
`orkestr doctor` reports Codex as healthy. You don't need to restart anything:
running daemons keep their release, and new ones start from `current`.

If you want this to happen regularly, put the snippet in a host-level cron job
or systemd timer for the service user, in your private deployment overlay. Keep
it out of this repository.
