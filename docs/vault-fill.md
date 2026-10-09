# Vault: filling logins into a managed desktop

`orkestr vault fill` types a vault credential into the field that currently
has keyboard focus on a managed browser desktop. The agent never sees the
value: the server reads it from the vault and hands it straight to the
desktop's keystroke process. The response is only `filled` or `failed`.

```sh
orkestr vault fill "Example Login" --desktop example-desk                  # password
orkestr vault fill "Example Login" --desktop example-desk --field username
orkestr vault fill "Example Login" --desktop example-desk --field both --submit
```

`--field both` types the username, presses Tab, then types the password.
`--submit` presses Enter afterwards. Exit code 0 means `filled`.

## Rules

- **Agents** (CLI credential plus thread token, like `vault exec`): the item
  must be granted to the thread, and the thread must hold a live, unexpired
  lease on the desktop (`POST /api/desktops/<slug>/acquire`, heartbeat,
  release; see `GET /api/desktops/leases`). Otherwise the request fails with
  `desktop_lease_required` (403), `desktop_lease_owned_by_other_thread` (409)
  or `desktop_lease_expired` (403). Fills count against the agent secret-read
  rate limit.
- **Owner** (WebUI, item menu "Fill into desktop"): needs a sign-in within
  the last 15 minutes, like reveal, and counts against the owner reveal limit.
  No lease is needed, so the owner can help a thread that is stuck on a login.
- **Single-use items** (`singleUse: true`) are used up by their first fill;
  later fills return `410 vault_item_used`. The check and the claim happen in
  the same vault write (`packages/core/src/vault-item-use.js`).
- **Audit:** each fill records a `vault_fill` event with item, thread (agents),
  desktop, field, submit and outcome, never the value.

## How the value travels

The server runs `xdotool type --clearmodifiers --file -` against the
desktop's X display and writes the value to that process's **stdin**. The
value is never in argv, the environment (the child gets only `DISPLAY` and
`PATH`), URLs, request bodies, logs, events, the perf log or thread messages,
and the **clipboard is never used**. Key presses (Tab, Enter) are separate
`xdotool key` calls. Child output is discarded. `ORKESTR_DESKTOP_KEYSTROKE_COMMAND`
overrides the `xdotool` binary (tests use a fake).

HTTP: `POST /api/vault/agent/fill {item, desktop, field?, submit?}` (agent) and
`POST /api/vault/items/:id/fill {desktop, field?, submit?}` (owner).

## Limits

- **Focused-field targeting only.** Orkestr does not check which element has
  focus. If the focus is in the address bar, a search box or a visible text
  field, the value is typed there and is visible on screen, including to an
  agent that can take screenshots of the desktop. Click into the right field
  first.
- Only desktops started by the local `browserctl` with an X display are
  supported; remote browser providers return `vault_fill_desktop_unsupported`.
- The keyboard layout of the desktop must match the characters of the value;
  `xdotool` handles most layouts but very unusual characters can fail.
- Processes running as the same OS user as the server can still observe the
  desktop session itself.
