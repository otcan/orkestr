# Vertical Product Readiness

Status: assessment only. The career-preparation vertical is parked; nothing
for it has been built.
Date: 2026-10-11.

Orkestr's free products are small, useful tools that work without an account,
an upload, or a lead form. The first pilot is the
[workout log](#pilot-1-workout-log). This document records what that pilot
established and assesses whether a second vertical, **career preparation**,
is ready to build.

## Rules every free product must meet

These come from the public-site strategy and apply to any future vertical:

- Useful on first visit: no account, no signup, no personal-data form.
- User data stays on the user's device unless the user exports it.
- No analytics, tracking pixels, or third-party scripts.
- Only verifiable claims. No invented users, results, or testimonials.
  Synthetic examples only; never client or private data.
- Not a consulting funnel: a free product links back to the catalog, not to a
  sales form.
- Works on mobile and desktop, passes the site's accessibility and CSP checks.

## Pilot 1: workout log

Route: `/free/workout-log`, listed under Free products at `/free`.

What it shows works for this format:

| Concern | How the pilot handles it |
| --- | --- |
| Storage | `localStorage` only, versioned JSON schema, tolerant of corrupt data |
| Data leaving the browser | Page CSP has `connect-src 'none'`; a browser test asserts no fetch/XHR/beacon |
| Portability | JSON export, all-or-nothing import (malformed, foreign, oversized, or partly invalid files are rejected with a clear message and existing data is untouched), delete-all |
| Interrupted actions | Repeated taps do not log a set twice; a running rest timer resumes after a reload; failed saves change nothing |
| Storage loss | The page states plainly that browser storage can be lost (clearing data, private mode, other device) and points to export as the backup |
| Offline | A small service worker caches only the page's own static files |
| Claims | Neutral disclaimer: logging tool, no training, health, or medical advice |
| Tests | Unit tests for progression, import, storage and timer logic; a headless-browser test covering every flow, reload persistence, keyboard use, offline use, and a 390px mobile viewport |

Reusable pattern for later verticals: a standalone page with a strict CSP, a
pure logic module that is unit tested in Node, a small storage module, and a
same-origin ES module client. No build step and no runtime dependencies.

## Candidate vertical 2: career preparation

### What was inspected

Three earlier internal career-related prototypes were reviewed read-only:

1. A paid, operator-assisted application-review website with an admin review
   pipeline, e-mail notifications, and payment instructions.
2. A CV-to-job-description fit report service: a server-side parsing and
   scoring pipeline with LLM extraction, a cache of public job postings, an
   account and checkout flow, and a set of editorial guide pages.
3. A static marketing landing page for an earlier paid job-search program.

The paid job-search service is discontinued and is **not** being restarted.
No code, content, or data from these prototypes has been copied into this
repository.

### What could be reused (after review)

| Asset | Reuse potential | Condition |
| --- | --- | --- |
| Skill and tool synonym vocabulary (term groups such as framework aliases) | High | Only the generic vocabulary; must be re-reviewed for licensing and accuracy, and rebuilt as a plain data file |
| Deterministic keyword matching idea (job text vs. CV text, no LLM) | High | Rewritten from scratch as a pure browser module, same pattern as the workout log |
| Editorial guide topics (why CVs get filtered, fitting a CV to one posting) | Medium | Rewritten; every claim checked; no "ATS score" style promises |
| Legal page structure | Low | The main site already has its own legal pages |
| Status pipeline, admin review, payment, account, and mail code | None | Belongs to a paid service model that free products do not use |

### Risks

- **Private data.** The prototypes hold real people's CVs as sample inputs,
  generated reports, and application records. None of it may be reused, even
  as "examples". A free product would need new synthetic CVs and postings.
- **Upload model conflict.** The existing fit report needs the CV on a server
  and an LLM call. The free-product rules require browser-only processing, so
  the core pipeline cannot be reused; only the deterministic part maps over.
- **Third-party data.** The job-posting cache came from public job boards.
  Redistributing it, even inside a static page, raises terms-of-use questions.
  A free tool should only analyze text the user pastes.
- **Claims and expectations.** Job-search tools invite outcome promises
  ("get more interviews"). Every result must be framed as text matching, with
  no prediction of hiring outcomes.
- **Regulatory sensitivity.** AI used to evaluate people for employment is a
  high-risk category under the EU AI Act. A candidate-side, deterministic,
  browser-only checker is a much lower-risk shape, but the copy must make clear
  it does not assess the person.
- **Tracking residue.** The earlier sites used a consent banner with a
  third-party analytics tag. Nothing from those pages may be carried over.
- **Brand confusion.** The discontinued paid service and its domains must not
  be referenced, so users do not expect the old paid offer to return.
- **Maintenance.** Keyword vocabularies age quickly; without an owner the tool
  degrades.

### Recommendation: no-go. Do not build without evidence

Do **not** build the career-preparation vertical, and do not start it on
assumption alone. It stays parked until there is evidence that people want a
browser-only career tool from Orkestr. The parts that made the earlier
prototypes valuable (server-side LLM analysis, job cache, operator review) all
conflict with the free-product rules, and the safe remainder is small.

Acceptable evidence must be gathered without tracking, accounts, or lead
forms, for example: repeated unsolicited requests through the existing public
contact channels, or a documented need from the owner's own direct
conversations. Page views or analytics are not an option because free products
carry no instrumentation.

Revisit only when that evidence exists and all of these are true:

1. The workout log has run for at least one release cycle without user-data
   issues, CSP regressions, or support load.
2. Someone owns the keyword vocabulary and its review cadence.
3. A synthetic CV and job-posting set exists that contains no real person's
   data.
4. The scope is limited to: paste a job posting and your CV text, see which
   terms match or are missing, everything computed in the browser, export or
   delete locally, no score that implies a hiring outcome.

If those hold, the build follows the workout-log pattern: one standalone page,
strict CSP, pure tested logic module, no network calls, a neutral disclaimer,
and a catalog entry under Free products.
