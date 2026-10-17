# Password-blind Chrome password handoff

Lets the owner create a new site password with Chrome's own generator on a managed desktop, while the agent thread working on that desktop never sees it. Orkestr never generates, types, reads or stores the password. It only reports value-free statuses.

## Flow

1. The agent reaches a signup form on the desktop it holds a lease for.
2. The owner, signed in recently (the vault's recent-auth window), opens a handoff for:
   - that desktop and the thread holding its lease;
   - the exact DevTools tab id;
   - the exact origin (https, or http on loopback for fixtures);
   - optionally a field selector (default: `input[autocomplete~=new-password]`).
3. Orkestr refuses unless every one of these holds:
   - the tab exists and its origin matches exactly, both as DevTools lists it and as the page itself reports it;
   - the field is a password field and is empty;
   - no other handoff is open on that desktop.
4. While the handoff is open the desktop is **password-blind** for agents. `operateManagedDesktop` (observe, read, extract, click, type, navigate) and agent vault fill refuse with `desktop_password_blind` (HTTP 423).
5. The owner, in the live desktop view, uses Chrome's "Suggest password…" and "Use strong password". Agents never click these.
6. The status (owner or the bound thread may ask) is one of:

   | Status | Meaning |
   |---|---|
   | `awaiting_owner` | Bound field present and empty. |
   | `accepted` | Field filled. `chromeFilled` tells whether Chrome autofilled it. A filled field is never proof of saving. |
   | `saved_verified` | Chrome's login store has a login for that exact origin created after the handoff started. |
   | `unknown` | The tab, origin or field cannot be confirmed, with a reason. A tab that is gone or an origin change closes the handoff as `aborted`. |

7. The owner ends the handoff, or it expires (10 minutes by default, 30 at most). Signup submission and accepting terms are separate, owner-gated steps outside this flow.

## What is read, and how

- **Field state:** one fixed DevTools `Runtime.evaluate` in the bound tab. It returns booleans only (found, is password, new-password, filled, Chrome autofilled). The value and its length are never read.
- **Save state:**
  - Chrome's `Default/Login Data` is opened with `mode=ro&immutable=1`, which also works while Chrome holds its exclusive lock.
  - Only `count(*)` is selected, filtered on `signon_realm` and `date_created`.
  - No usernames or password columns are selected, and the file is never copied.
- **Events** (`password_handoff_started`, `_aborted`, `_expired`, `_ended`) and the handoff store (`ORKESTR_HOME/password-handoffs.json`) contain ids, origin and status words only.

## Not covered yet (blockers before live use)

- **Raw DevTools access:** an agent process that already has the desktop's DevTools port can still read the page or take screenshots directly. Orkestr's blind flag stops Orkestr's own agent paths, not a raw CDP client. Live use needs one of these:
  - a CDP proxy that refuses agents while the desktop is blind;
  - DevTools port isolation per lease;
  - the agent process stopped or suspended for the duration.
- **Chrome's generation and save behaviour:** this is not exercised by the tests. Headless Chrome has no generation UI, so the synthetic tests type the value to simulate acceptance and insert a fake login row to simulate the save. On a real desktop, Chrome may save a generated password only after form submission. Then `saved_verified` would stay unreachable until submission, which this flow does not do.
- **No HTTP or CLI routes yet:** the core module is ready for owner routes and the live desktop view.
