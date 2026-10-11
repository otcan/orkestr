# Public Site Architecture

The marketing website is a separate static site. It is built and deployed
outside this repository. The Orkestr app does not render marketing pages.

## Host responsibilities

| Host | Responsibility |
| --- | --- |
| public site host (`ORKESTR_PUBLIC_SITE_URL`) | Static marketing pages from the separate site. The web server forwards `/api/public/*`, plus the paths the static site does not have, to an Orkestr app. |
| app host | Authenticated Orkestr application and application launcher |
| connect host | Secure pairing and connector authorization entry |

The public host must never render private application or instance state.

## What the app still serves on the public host

The app renders these only for the configured public site host. A self-hosted
install without `ORKESTR_PUBLIC_SITE_URL` serves the app and setup wizard at
`/` and renders none of them.

- `/` and `/about`: the OAuth homepage. It names the app, explains its Google
  data use, and links privacy, terms and support. When the static site sits in
  front, the web server answers `/` instead.
- Legal and support: `/terms`, `/privacy`, `/impressum`, `/acceptable-use`,
  `/data-deletion`, `/support`.
- `/beta`: the personal beta page with the waitlist form. `/waitlist`
  redirects to `/beta#waitlist`.
- Lead-form pages: `/project`, `/de/projekt`, `/tr/proje`, `/workflow`.
- `/public-site.css` and `/robots.txt`.

## Lead-form and event endpoints

These stay in the app, whichever host serves the form pages:

- `POST /api/public/project-inquiries` stores Project Discovery separately from
  workflow leads and beta waitlist records. Quick submissions require only
  project type, desired outcome, contact name, work email, and consent; deeper
  context is optional. A valid `ORKESTR_PROJECT_DISCOVERY_SCHEDULING_URL` is
  the direct booking action and post-submit handoff. Without it, the quick form
  is the native call-request fallback.
- `POST /api/public/workflow-leads` handles the Workflow Audit form and its own
  qualified scheduler setting.
- `POST /api/public/waitlist` handles the beta waitlist.
- `POST /api/public/events` receives the opt-in page analytics beacon from
  allowlisted public paths (`packages/core/src/public-site-events.js`).
