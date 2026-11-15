# V2 Sites (ORK-834)

Chats can publish a folder as a static microsite, and the host can register
an app, each at its own address: `https://<slug>.<sites domain>/`. The host
side (DNS, TLS, sign-in in front of the sites, serving, and the publishing
tool) writes one catalog file. The V2 server reads that file and shows the
sites in the web app: a **Site** link in the header of the chat that
published one, and a **Sites** page that lists them all.

The server never fetches a site, never serves one, and never writes the
catalog. The catalog names sites only; it holds no content and no secret.

## 1. Catalog file

`<ORKESTR_V2_HOME>/sites-catalog.json`, or the file named by
`ORKESTR_V2_SITES_CATALOG`. The path is resolved once at startup; the file is
read again on each request, so a publish shows without a restart.

The host's publishing tool writes it atomically (write a temporary file, then
rename it over the old one). The server reads it only when its custody holds:

- a regular file, not a symlink, with one link;
- owned by root or the server's own user;
- not writable by group or others (for example mode `0600`, owner = the
  server's user);
- at most 1 MiB.

```json
{"format": "orkestr-sites-catalog-v1",
 "generated_at_ms": 1763208000000,
 "sites": [
   {"slug": "notes", "title": "Team notes", "url": "https://notes.sites.example.com/",
    "kind": "static", "conversation_id": "00000000-0000-4000-8000-000000000001",
    "published_at_ms": 1763207000000, "version": "v0003", "versions": 3, "status": "live"},
   {"slug": "crm", "title": "CRM", "url": "https://crm.sites.example.com/",
    "kind": "app", "conversation_id": null,
    "published_at_ms": 1763100000000, "version": null, "versions": 0, "status": "live"}
 ]}
```

| Field | Rule |
| --- | --- |
| `format` | Exactly `orkestr-sites-catalog-v1`. |
| `generated_at_ms` | Required. There is no staleness rule: the file changes only when something is published. |
| `sites` | At most 2,000 entries. |
| `slug` | `^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$` |
| `title` | Optional, may be empty: the page then shows the slug. Trimmed, at most 200 characters; a title with control characters is treated as empty. |
| `url` | `https://` only, and its host must be `<slug>.<domain>` (an optional port is allowed, user info is not). Plain ASCII without spaces, quotes, `<`, `>`, `\` or backticks, at most 512 bytes. Kept as written. |
| `kind` | `static` (a published folder) or `app`. |
| `conversation_id` | The publishing chat's conversation id (hyphenated UUID), or `null` for a site no chat published. |
| `published_at_ms` | The last publish, milliseconds since the epoch, not negative. |
| `version` | Optional label of the live version: 1 to 64 visible ASCII characters, no spaces (otherwise treated as absent). |
| `versions` | Optional count of published versions (absent or `null` = 0). |
| `status` | `live`, or `disabled` (listed greyed, with no Open link). |

Unknown fields are ignored. An entry that breaks a rule above (or has a field
of the wrong type) is dropped on its own; the others are still listed. When
two entries share a slug, the first one wins.

## 2. Endpoint

`GET /api/v2/sites` needs the owner's password-signed-in browser session,
exactly like the Credentials page (`credentials.md`): a machine bearer token,
a service session, or a bearer beside the cookie is refused with `401`. The
answer is never cached (`Cache-Control: no-store`). Sites are sorted by
`published_at_ms`, newest first:

```json
{"configured": true,
 "sites": [{"slug": "notes", "title": "Team notes", "url": "https://notes.sites.example.com/",
            "kind": "static", "conversation_id": "00000000-0000-4000-8000-000000000001",
            "published_at_ms": 1763207000000, "version": "v0003", "versions": 3, "status": "live"}]}
```

| Situation | Answer |
| --- | --- |
| No file (nothing published yet) | `{"configured": false, "sites": []}` |
| File used | `{"configured": true, "sites": [...]}` |
| File refused | `200` with `{"configured": true, "error": "<code>", "sites": []}`, never a `500` |

Error codes: `custody_rejected` (owner, mode, links or file type),
`unreadable`, `too_large`, `invalid_json` (not JSON, or a required top-level
field is missing or of the wrong type), `unknown_format`, `too_many_sites`.
The server logs a refusal once (`sites: catalog refused (<code>) ...`), and
again only when the reason changes or after the file was usable (or absent)
in between.

`/api/v2/health` lists the feature `sites_v1`.

## 3. Web app

- **Chat header.** When the open chat has a live site (its
  `conversation_id` is the open conversation), the header shows a **Site**
  link to the newest live one. It opens in a new tab
  (`target="_blank" rel="noopener noreferrer"`). If the chat has more sites,
  a small **+N** button next to it opens the Sites page. No link shows for a
  chat without a live site, a linked V1 chat, an older server without the
  route, or when the list could not be read.
- **Sites page** (`#sites`). Opened from Orkestr settings ("Open sites") or
  from a chat's **+N**. One row per site: title (or slug) and address, the
  chat by name (from the conversation list; "No chat" for `null`, "Chat not
  in your list" for an id the list does not show), kind (Static site or App),
  last publish (relative, with the exact UTC time as a tooltip), version, and
  an Open link (new tab, no opener). Disabled sites are greyed and say
  "Disabled" instead. On a phone each site is a card. With no sites, the page
  explains that a chat publishes a folder with `orkestr-site publish <folder>`.
  A refused catalog shows a short notice in plain words.
- **Refresh.** The app reads the list once when it opens, every minute while
  it is open, and each time the Sites page opens. After a `404` (an older
  server) or a `401` it stops the periodic reads; opening the Sites page
  tries again. A failed read never signs the owner out.
- The request bridge (`apps/ui/src/request.js`) admits only
  `GET /api/v2/sites`; the app never requests a site itself.

## 4. Tests

- Server: `apps/server/src/sites_http/catalog.rs` (parsing and validation,
  custody) and `sites_http/tests.rs` (the route through the real router and
  guard: refused sessions, missing and refused files, the logged refusal,
  `sites_v1`).
- UI: `apps/ui/tests/sites.rs`, `tests/route.rs`, `tests/request.test.mjs`,
  `tests/selected_conversation.test.mjs`.
- Browser: `v2/ci/headless-sites.mjs` with `headless-sites-mock.mjs`, run by
  `headless-workspace.mjs` at desktop and phone widths (screenshots
  `*-sites-header.png`, `*-sites.png`, `*-sites-empty.png`).
