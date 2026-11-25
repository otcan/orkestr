# V2 Apps page: the owner's tools and apps

The web app has an **Apps** button in its header. It opens one page with
links to the web apps the host runs beside Orkestr, for example the credential
store's own UI or an ops dashboard, followed by the live sites the owner's
chats published (`sites.md`). Every link opens in a new tab.

The host keeps the list in one small file that the V2 server reads. A new
link shows the next time the page opens, with no release of the web app and
no restart of the server. The server never fetches a link, never serves one
and never writes the file. The file holds names and addresses only, never a
secret.

## 1. Links file

The file is `<ORKESTR_V2_HOME>/app-links.json`, or the file named by
`ORKESTR_V2_APP_LINKS`. The path is resolved once at startup, and the file is
read again on each request.

Edit it atomically: write a temporary file, then rename it over the old one.
The server reads it only when its custody holds, the same rules as the sites
catalog:

- a regular file, not a symlink, with one link;
- owned by root or the server's own user;
- not writable by group or others (for example mode `0600` or `0644`);
- at most 256 KiB.

```json
{"format": "orkestr-app-links-v1",
 "links": [
   {"id": "vault", "title": "Vault (passwords)", "url": "https://vault.example.com/ui/",
    "group": "Tools", "description": "Passwords, tokens and API keys.",
    "hint": "Sign in with OIDC (your Orkestr login)"},
   {"id": "crm", "title": "CRM", "url": "https://crm.example.com/", "group": "CRMs"}
 ]}
```

| Field | Rule |
| --- | --- |
| `format` | Exactly `orkestr-app-links-v1`. |
| `links` | At most 200 entries. The page keeps their order. |
| `id` | `^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$`. When two entries share an id, the first one wins. |
| `title` | Required. It is trimmed and cut to 80 characters. A title that is empty or has a control character drops the entry. |
| `url` | `https://` only. The host must be a DNS name with a parent domain: no bare name and no IP address. An optional port is allowed; user info is not. Plain ASCII without spaces, quotes, `<`, `>`, `\` or backticks, at most 512 bytes. Kept as written. |
| `group` | Optional heading, cut to 40 characters. Absent, empty or with a control character: `Apps`. The groups appear in the order of their first link. |
| `description` | Optional. One line saying what the app is, cut to 200 characters. With a control character, a line break included, it is left out. |
| `hint` | Optional. One line saying how to get in, for example which sign-in to use. Same rules as `description`. |

Unknown fields are ignored. An entry that breaks a rule above, or has a field
of the wrong type, is dropped on its own; the others are still listed.

## 2. Endpoint

`GET /api/v2/app-links` needs the owner's password-signed-in browser session,
exactly like the Sites and Credentials pages. A machine bearer token, a
service session, or a bearer sent beside the cookie is refused with `401`, so
no other session learns these addresses. The answer is never cached
(`Cache-Control: no-store`). Links come in the file's order:

```json
{"configured": true,
 "links": [{"id": "vault", "title": "Vault (passwords)", "url": "https://vault.example.com/ui/",
            "group": "Tools", "description": "Passwords, tokens and API keys.",
            "hint": "Sign in with OIDC (your Orkestr login)"},
           {"id": "crm", "title": "CRM", "url": "https://crm.example.com/", "group": "CRMs",
            "description": null, "hint": null}]}
```

| Situation | Answer |
| --- | --- |
| No file | `{"configured": false, "links": []}` |
| File used | `{"configured": true, "links": [...]}` |
| File refused | `200` with `{"configured": true, "error": "<code>", "links": []}`, never a `500` |

The error codes are:

- `custody_rejected`: the owner, mode, links or file type is wrong;
- `unreadable`;
- `too_large`;
- `invalid_json`: the file is not JSON, or `format` is missing;
- `unknown_format`;
- `too_many_links`.

The server logs a refusal once (`app links: list refused (<code>) ...`). It
logs again only when the reason changes, or when the file was usable or
absent in between.

`/api/v2/health` lists the feature `app_links_v1`.

## 3. Web app

- **Header.** The **Apps** button sits between Virtual desks and Settings, and
  is marked while the page is open. It shows to the signed-in owner. The page
  itself asks the server, so a session the route refuses sees no links.
- **Apps page** (`#apps`, kept on reload):
  - **Links.** The host's links come first, under their group headings. Each
    is a card: the title and address open the link in a new tab
    (`target="_blank" rel="noopener noreferrer"`), followed by the
    description and the hint.
  - **Published sites.** The live sites from the sites catalog follow, newest
    first, with their kind. They come from the same shared list that the chat
    header and the Sites page read. Disabled sites are left out.
  - **All sites and versions** opens the Sites page.
  - **Phones** get one column.
- **Reads.** Opening the page reads the links once, and the sites list again.
  A `404` means an older server: the page shows no links section and still
  shows the sites. A failed read offers "Try again" and never signs the owner
  out.
- **What the page says when there are no links:**
  - with no file or an empty list, that the host lists none yet;
  - with a refused file, a short notice in plain words, never the code.
- **Request bridge.** `apps/ui/src/request.js` admits only
  `GET /api/v2/app-links`. The app never requests a link itself.

## 4. Tests

- **Server:** `apps/server/src/app_links_http/catalog.rs` covers parsing,
  validation and custody. `app_links_http/tests.rs` runs the route through the
  real router and guard: refused sessions, missing and refused files, the
  logged refusal, and `app_links_v1`.
- **UI:** `apps/ui/tests/app_links.rs`, `tests/route.rs`,
  `tests/request.test.mjs` and `tests/selected_conversation.test.mjs`.
- **Browser:** `v2/ci/headless-apps.mjs` with `headless-apps-mock.mjs`. It is
  run by `headless-workspace.mjs` at desktop and phone widths and saves the
  screenshots `*-apps.png` and `*-apps-empty.png`.
  `headless-shell-navigation.mjs` checks that the header stays on one row at
  every width and saves `shell-<width>-apps.png`.
