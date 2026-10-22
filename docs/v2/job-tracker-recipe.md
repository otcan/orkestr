# Job tracking recipe: recipes, tracker table and Thunderbird mail reader

Status: implemented on `v2/rust-rewrite` (ORK-607, ORK-605 reader half;
migration `0067`). Spec: ORK-607 recipe spec (JT15 epic ORK-602).

## Recipes (`v2/recipes/<id>/`)

A recipe is data: `recipe.json` (`orkestr.recipe.v1`), the run instructions
(`instructions.md`) and, for the job tracker, the mail rule pack
(`rules.json`, `orkestr.jobmail-rules.v1`). The server embeds the shipped
recipes at build time and refuses a malformed one (unit-tested).

- `GET /api/v2/recipes` (owner): gallery entries with the schedule in words.
- `POST /api/v2/recipes/{id}/install {request_key, timezone, mail_profile?}`
  (browser owner, CSRF): creates the conversation, turns on its tracker
  (`notify_on`), stores the mail source, creates and enables the calendar
  timer(s) in the installer's zone with the policy from the recipe, and
  issues the tracker grant (returned once). A replay of the same
  `request_key` returns the same conversation (200) and creates nothing.

`job-tracker` creates "Job tracker" with one calendar timer: hourly at :00,
Monday to Friday, 09:00 to 20:00 local, `silent_mode: unless_changed`. Its
instruction runs the mail scan and answers exactly `NO_NEWS` when nothing
changed (suppressed by the silent policy), otherwise at most ten summary
lines. It never sends mail and treats email text as untrusted data.

## Tracker (`/api/v2/conversations/{id}/tracker`)

One structured table per conversation: company, role, source, status,
applied, last contact, next step, link, location, notes, confidence,
needs-review, archived, plus an append-only event timeline per row.

| Route | Who | What |
| --- | --- | --- |
| `GET /tracker` | owner, grant | rows (newest contact first) |
| `PUT /tracker {recipe, notify_on?}` | owner | turn on (idempotent) |
| `POST /tracker/events {request_key, events[]}` | owner, grant | record events; returns the changeset |
| `GET /tracker/rows/{row}/events` | owner, grant | timeline |
| `POST /tracker/rows/{row} {expected_revision, ...}` | owner | inline edit; a status edit is a `manual` event and always wins |
| `POST /tracker/merge {keep, absorb}` | owner | merge two rows |
| `GET /tracker/export.csv?delimiter=comma\|semicolon` | owner, grant | CSV (UTF-8 BOM, ISO dates, formula cells neutralised) |
| `POST\|DELETE /tracker/grant` | owner | issue (shown once, stored hashed) / revoke |
| `POST /tracker/mail-scan` | owner, grant | one bounded scan of the mail source |
| `GET\|PUT /tracker/mail-source {profile?, folders[]}` | owner | source status / set it (restarts the cursor) |

The grant (`x-orkestr-tracker-grant`) authorizes only these routes of this
conversation and is refused together with a cookie, Authorization or Origin.

Dedupe and merge, in order: canonical job link (tracking parameters dropped,
LinkedIn `/jobs/view/<id>` unified, every link of a row is remembered), then
company key + role key (legal forms, gender markers and parenthesised parts
removed), then company alone for role-less mail when exactly one open row
matches (several: the most recent, flagged for review). A job alert and a
later recruiter mail or application for the same job therefore share one
row. Status is monotonic (saved < applied < in review < assessment <
interview < offer); rejected/withdrawn win, an older terminal mail never
closes a row that moved on, and a positive event after a terminal one asks
for review. Each mail message is recorded once (`tracker_ledger`, hashed
Message-ID); batches are idempotent by `request_key`.

Silent unless changed: a scan or batch is news only for a new application
(not a quiet alert lead), a status change, or a new review flag.

## Mail reader (`v2/crates/mail-reader`)

Read-only, bounded, incremental reader of Thunderbird's local store (the
ORK-605 lead path: Thunderbird signs in with its own Google OAuth; Orkestr
holds no Google credential).

- Profile discovery: `profiles.ini` under `~/.thunderbird`, snap and flatpak
  locations (Linux), `~/Library/Thunderbird` (macOS), `%APPDATA%\Thunderbird`
  (Windows); the `[Install…]` default first. `ImapMail/<server>/INBOX` and
  `Mail/<account>/Inbox` as Maildir or mbox, plus optional extra folders
  (a Gmail "Jobs" label).
- Never opened: `logins.json`, `key4.db`, `cert9.db`, `cookies.sqlite` and
  the other credential stores. Files are only opened for reading.
- Cursor: Maildir names seen (flag renames are not new mail; deleted mail
  leaves the cursor), mbox byte offset with a head digest (compaction
  restarts; the ledger drops repeats). Messages modified in the last 2 s
  wait; at most 500 messages, 4 MiB per message, 64 MiB of mbox per scan;
  mail older than `since_days` (60) is skipped; Thunderbird-expunged mbox
  messages are skipped.
- MIME: headers, RFC 2047, multipart, base64, quoted-printable, UTF-8,
  Latin-1/9, Windows-1252, HTML to text with links.
- Sources: the inbox and the user's Sent folder (`[Gmail]/Sent Mail`,
  `Gesendet`, `Sent`). Sent mail is the primary source of applications
  (many applications, for example to freelance agencies, never produce a
  confirmation email).
- Classification (rule pack `jobmail-rules@2`), lessons from a run over
  real mail where keyword rules misfired on marketing and newsletters:
  - Outgoing mail to an employer or agency with application wording
    ("Bewerbung", "anbei mein Profil", "Tagessatz", "application", "CV")
    creates or advances a row (`applied`); mail to personal providers
    (gmail.com, web.de, ...) is private.
  - Status changes are gated: only trusted transactional senders
    (LinkedIn Easy Apply, ATS, assessment vendors) with aligned DKIM may
    create or move a row on their own. Everything else (agencies, employers
    writing directly, unknown senders) counts only as a reply in the thread
    of a known application or lead (`In-Reply-To` / `References` matched
    against the hashed Message-IDs the tracker recorded); otherwise it is
    dropped (`not_in_thread`), whatever its keywords say.
  - Bulk and marketing mail (`List-Unsubscribe`, `List-Id`,
    `Precedence: bulk|list|junk`, campaign headers) is dropped unless it
    comes from LinkedIn or an ATS; a sender denylist is available as data.
  - Agency and platform mail that is not a reply becomes a lead (`saved`)
    only when a role can be extracted ("Projektanfrage: Data Engineer").
    German freelance agencies and platforms are covered (Hays, SThree /
    Computer Futures, Randstad / GULP, Etengo, emagine, Akkodis, RED Global,
    Westhouse, SOLCOM, Michael Page, freelance.de, freelancermap, Malt).
  - Rejection phrases are vetoed by positive wording ("great news",
    "confirmed you", "onboarding", "Zusage", "freuen uns").
  - Spoofed LinkedIn mail is dropped; unauthenticated ATS mail is not
    trusted (needs a thread).

Tests use synthetic mail only (`tests/fixtures/generate.py`, fictional
companies and people); a test refuses fixture senders outside fictional and
vendor domains.

## Known gaps

- The hourly run needs the tracker grant in the assistant's environment
  (`ORKESTR_TRACKER_GRANT`); V2 has no per-conversation environment
  injection yet. "Check mail now" in the Tracker tab works without it.
- No LLM stage for ambiguous mail (ORK-607 §5.3), no digest/stale check, no
  CSV import, no Thunderbird provisioning or supervision (ORK-604/605).
- The rule pack is proven on 43 synthetic messages (including each real-mail
  failure mode), not yet re-measured on real mail.
- Thunderbird must keep the Sent folder offline too (the ORK-605 profile
  provisioning syncs INBOX only). A reply scanned before its application was
  synced is not re-evaluated later.
