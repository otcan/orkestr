# Password-blind Chrome password handoff

Lets the owner create a new site password with Chrome's own generator on a managed desktop, while the agent thread working on that desktop never sees it. Orkestr never generates, types, reads or stores the password. It only reports value-free statuses.

## Trust model

The handoff keeps the password out of everything Orkestr shows or stores:
- agent desktop tools, screenshots and OCR;
- the agent API;
- desktop shares, logs and events.

It does **not** stop a process that deliberately bypasses Orkestr. Examples are an agent with root on the host, or any local process that connects to Chrome's DevTools port. Use it where the agents are trusted not to work around Orkestr, for example a single-user install. Against hostile agents, use a separate desktop host that agents cannot reach.

## Flow

1. The agent reaches a signup form on the desktop it holds a lease for.
2. The owner, signed in recently (the vault's recent-auth window), opens a handoff for:
   - that desktop and the thread holding its lease;
   - the exact DevTools tab id;
   - the exact origin (https, or http on loopback for fixtures);
   - optionally a field selector (default: `input[autocomplete~=new-password]`). Only value-free forms are accepted: `#id`, or `input[name|id|autocomplete=word]`.
3. Orkestr refuses unless every one of these holds:
   - the tab exists and its origin matches exactly, both as DevTools lists it and as the page itself reports it;
   - no other tab has the same origin (`ambiguous_tab`), so a save can be attributed to this tab;
   - the field is a password field and is empty;
   - no other handoff is open on that desktop.
4. While the handoff is open the desktop is **password-blind**. Every path except the handoff owner's own vault-owner browser session refuses with `desktop_password_blind` (HTTP 423):
   - agent desktop operations (`operateManagedDesktop`: observe, read, extract, click, type, navigate);
   - agent vault fill;
   - tenant agent desktop skill actions (open, open_url, start, stop, restart);
   - `POST /api/browser-sessions/:slug/:action` and `/api/browsers/:slug/:action`;
   - the `/desktop/:slug/…` HTTP and websocket (noVNC) proxy.
   - Agent actions (lifecycle, operate, vault fill) run their check and their effect under a per-desktop gate, which also covers handoff start. An action already running finishes before the handoff opens. Desktop shares, machine credentials and the local operator proxy count as non-owner. Websockets already open when the handoff starts are cut, except the owner's.
5. The owner, in the live desktop view, uses Chrome's "Suggest password…" and "Use strong password". Agents never click these.
6. The status is one of the values below. Two callers may ask: the owner's vault-owner session (`ownerPasswordHandoffStatus`), or the thread the handoff is bound to, resolved from its own thread identity (`agentPasswordHandoffStatus`).

   | Status | Meaning |
   |---|---|
   | `awaiting_owner` | Bound field present and empty. |
   | `accepted` | Field filled. `chromeFilled` tells whether Chrome autofilled it. A filled field is never proof of saving. |
   | `saved_verified` | Chrome's login store has a login for that exact origin created after the handoff started, the bound tab is the only tab on that origin, and no unread journal is pending. |
   | `unknown` | The tab, origin or field cannot be confirmed, with a reason (`tab_not_found`, `origin_mismatch`, `ambiguous_tab`, …). |

   `saveCheck: journal_pending` means Chrome's `-wal` or `-journal` file has writes the read cannot see. The save is then unconfirmed either way.

7. **Only the owner ending the handoff unblinds the desktop.** End reasons are `owner_ended`, `owner_cancelled` and `signup_abandoned`; free text is refused. A lost tab, an origin change or expiry (10 minutes by default, 30 at most) changes only the reported status (`expired: true`), because the password may still be on screen. Signup submission and accepting terms are separate, owner-gated steps outside this flow.

## Where to use it

On the **Vault** page, choose **New site password with Chrome…**:
- pick the desktop; the page shows which thread holds its lease and the desktop's https tabs, by origin only;
- pick the signup tab and choose **Lock agents out and start**;
- choose **Open desktop**, then use Chrome's suggested password and let Chrome save it;
- choose **Done**, or **Cancel** if you give up on the signup.

Routes (all under `/api/vault`):

| Route | Who |
|---|---|
| `GET password-handoffs[?desktop=]` | Owner session: open handoffs. |
| `GET password-handoffs/targets?desktop=` | Owner session: the lease thread and `{ targetId, origin }` tabs. |
| `POST password-handoffs` `{ desktop, threadId, targetId, origin, selector?, ttlMs? }` | Owner session, recent sign-in, same origin. |
| `GET password-handoffs/:id` | Owner session: status. |
| `POST password-handoffs/:id/end` `{ reason }` | Owner session, same origin. |
| `GET agent/password-handoffs/:id` | The agent CLI with the bound thread's token: status only. |

## What is read, and how

- **Field state:** one fixed DevTools `Runtime.evaluate` in the bound tab. It returns booleans only (found, is password, new-password, filled, Chrome autofilled). The value and its length are never read.
- **Save state:**
  - Chrome's `Default/Login Data` is opened with `mode=ro&immutable=1`, which also works while Chrome holds its exclusive lock.
  - Only `count(*)` is selected, filtered on `signon_realm` and `date_created`.
  - No usernames or password columns are selected, and the file is never copied.
- **Events** (`password_handoff_started`, `password_handoff_ended`) and the handoff store (`ORKESTR_HOME/password-handoffs.json`) contain ids, origin and status words only.

## Not covered yet (blockers before live use)

- **Raw DevTools access (accepted for single-user installs, see Trust model):** Chrome's DevTools port listens on loopback, so any local process can connect to it, whatever user it runs as. Such a process can read the page or take screenshots directly. Orkestr's blind flag stops Orkestr's own paths, not a raw CDP client, and nothing helps against agents with root on the host. Against unprivileged agents, live use needs one of these:
  - a CDP proxy that refuses agents while the desktop is blind;
  - DevTools port isolation per lease;
  - the agent process stopped or suspended for the duration.
- **Chrome's generation and save behaviour:** this is not exercised by the tests. Headless Chrome has no generation UI, so the synthetic tests type the value to simulate acceptance and insert a fake login row to simulate the save. On a real desktop, Chrome may save a generated password only after form submission. Then `saved_verified` would stay unreachable until submission, which this flow does not do.
- **The websocket cut uses an in-process notice.** Start a handoff only through the server routes below, never from a separate process.
- **Same-origin tabs between checks:** a tab opened and closed between two status checks is not seen. The owner should keep a single tab on that origin.
