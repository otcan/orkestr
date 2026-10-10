# Vault: filling logins into a managed desktop

`orkestr vault fill` types a vault credential into the field that currently
has keyboard focus on a managed browser desktop. The agent never sees the
value: the server reads it from the vault and hands it straight to the
desktop's keystroke process. The response is only `filled` or `failed` with a
value-free reason.

```sh
orkestr vault fill "Example Login" --desktop example-desk                  # password
orkestr vault fill "Example Login" --desktop example-desk --field username
orkestr vault fill "Example Login" --desktop example-desk --field both --submit
```

`--field both` types the username, presses Tab, then types the password.
`--submit` presses Enter afterwards. Exit code 0 means `filled`.

## Focus check

Before each value is typed, Orkestr asks the desktop's Chrome through
DevTools which element has focus. This is read-only: one `Runtime.evaluate`
of `document.hasFocus()` / `document.activeElement` per open tab, no input,
no navigation, no field values. Exactly one tab must have focus, and:

| Typing | Focused element must be | Otherwise |
| --- | --- | --- |
| password | a writable `input type=password` | `focus_not_password_field` |
| username | a writable `input type=text` or `type=email` | `focus_not_username_field` |
| both | first a username input whose form has a password input; after Tab, a password input | as above |

Focus in the address bar, a search box, another browser window or an iframe
does not pass, so nothing is typed. If DevTools is unreachable (the desktop
has no `cdp_url`), the fill fails with `focus_unverifiable`. Only the owner
can override that case with `"allowUnverifiedFocus": true` on
`POST /api/vault/items/:id/fill`; a focus that is known to be wrong is always
refused. Refused fills type nothing and do not use up a single-use item.
Failures return `{ "status": "failed", "reason": "..." }` (also
`typing_failed`) and are audited with the reason.

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
- **Single-use items** ([vault.md](vault.md#single-use-items)) are used up by
  their first *completed* fill; later fills and `exec` return
  `410 vault_item_used`. A fill refused by the focus check or that fails to
  type consumes nothing. The item is reserved while typing (concurrent uses
  get `409 vault_item_in_use`) and wiped once the fill completes
  (`packages/core/src/vault-item-use.js`).
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
`POST /api/vault/items/:id/fill {desktop, field?, submit?, allowUnverifiedFocus?}`
(owner).

## Limits

- **Focused-field targeting.** Values go to the focused field, so click into
  it first. The focus check stops the address bar, search boxes and text
  areas, but cannot tell a real login form from a page that only imitates
  one, and the focus can change in the short gap between check and typing.
- Login forms inside iframes are refused (the focused element is the iframe).
- Only desktops started by the local `browserctl` with an X display are
  supported; remote browser providers return `vault_fill_desktop_unsupported`.
- The keyboard layout of the desktop must match the characters of the value;
  `xdotool` handles most layouts but very unusual characters can fail.
- Processes running as the same OS user as the server can still observe the
  desktop session itself.
