# Commercial Site Release QA

Release scope: Homepage V4 simplified business-systems positioning, a
booking-first Project Discovery route, adaptive quick intake, retained solution
and Workflow Audit routes, public-safe proof, responsive design, privacy, and
metadata-only analytics.

## Changed surfaces

- Six-section homepage: hero, three service groups, three problem examples,
  four-step delivery, one platform proof block, and final booking CTA
- `/use-cases` plus BUILD, REPLACE, FIND, COLLECT, and AUTOMATE detail routes
- `/project` direct scheduler action or native call-request fallback, four-answer
  adaptive brief, optional context, and `/api/public/project-inquiries`
- Header, footer, metadata, sitemap, privacy, terms, event allowlist, and docs
- Existing `/workflow` remains the specialized automation entry offer

Project inquiries, workflow leads, and personal-beta waitlist records use
separate files and endpoints. A configured Project Discovery scheduler is a
direct booking action. Without it, the short inquiry is the native fallback.
The specialized Workflow Audit scheduler remains qualification-gated.

## Required gates

- `npm run build`
- focused project-inquiry, workflow-lead, commercial, static-server, security,
  privacy, and analytics tests
- full CI test runner
- `npm run smoke`
- `npm run oss:boundary-check`
- `git diff --check`
- desktop and phone render of all commercial and legal routes with no horizontal
  overflow and reachable form controls
- synthetic quick and detailed Project Discovery submissions, with and without a
  scheduler, plus a Workflow Audit submission with no scheduler configured
- unauthenticated private API, application, auth, and privacy exposure gates

## ORK-448 local evidence

| Gate | Result |
| --- | --- |
| Production build | Pass; web bundle 1.19 MB raw / 252.66 kB estimated transfer |
| Changed-surface suite | 83/83 pass |
| Full CI runner | 2,122 pass, 6 skip, 0 fail (2,128 total) |
| Smoke | Pass |
| OSS boundary | Pass; 648 files scanned |
| Diff check | Pass |

## ORK-449 system-first follow-up evidence

ORK-449 changes the homepage's default requirement, Console proof, approval
example, and Project Discovery placeholder from opportunity discovery to a
legacy business-system replacement. Opportunity intelligence remains available
as a later selectable scenario and dedicated solution route.

| Gate | Result |
| --- | --- |
| Production build | Pass; web bundle 1.19 MB raw / 252.66 kB estimated transfer |
| Changed-surface suite | 51/51 pass |
| Full CI runner | 2,122 pass, 6 skip, 0 fail (2,128 total) |
| Smoke | Pass |
| OSS boundary | Pass; 648 files scanned |
| Diff check | Pass |

## ORK-450–455 Homepage V4 conversion evidence

The V4 candidate reduces the homepage to six direct sections and changes
Project Discovery from a long qualification gate to an immediate booking action
plus a four-answer adaptive fallback. FIND and COLLECT remain available on
supporting pages and inside work-and-data automation, but do not lead the main
commercial narrative.

| Gate | Result |
| --- | --- |
| Production build | Pass; web bundle 1.19 MB raw / 252.66 kB estimated transfer |
| Changed-surface suite | 111/111 pass |
| CI test runner | 2,124 pass, 6 skip, 0 fail (2,130 total) |
| Desktop and phone render | Pass at 1440×1000 and 390×844; zero horizontal overflow |
| Booking modes | Pass; direct configured calendar and native no-calendar fallback |
| Homepage contract | Pass; exactly six top-level V4 sections |
| Smoke | Pass |
| OSS boundary | Pass; 649 files scanned |
| Diff check | Pass |

Responsive browser rendering, production route checks, both synthetic intake
submissions, and unauthenticated exposure checks remain post-merge release-train
gates and must not be inferred from the local source contracts alone.

Claims review must confirm that project briefs and Console data are illustrative,
scraping is described only as a technique, sources are public or authorized,
AI is not prescribed for every build, feasibility is not guaranteed, and no
customer, certification, compliance, benchmark, ROI, or universal-integration
claim is introduced.

After deployment, verify version and health, every sitemap route, both intake
paths, responsive behavior, public/private host separation, no private markers,
and application authentication. Roll back using the release train's recorded
prior release id on route failure, private exposure, broken authentication,
unreadable layout, failed inquiry capture, unsafe scheduler exposure, or broken
booking fallback.
