# Commercial Site Release QA

Release scope: Homepage V3 business-systems positioning, five solution routes,
general Project Discovery intake, retained Workflow Audit specialization,
public-safe platform proof, responsive design, privacy, and analytics.

## Changed surfaces

- Homepage hero, rotating requirement diagram, solution breadth, ugly-problem
  prompts, project examples, delivery model, platform proof, browser capability,
  human control, deployment, security, FAQ, and Project Discovery CTAs
- `/use-cases` plus BUILD, REPLACE, FIND, COLLECT, and AUTOMATE detail routes
- `/project` intake and `/api/public/project-inquiries`
- Header, footer, metadata, sitemap, privacy, terms, event allowlist, and docs
- Existing `/workflow` remains the specialized automation entry offer

Project inquiries, workflow leads, and personal-beta waitlist records use
separate files and endpoints. Scheduler URLs appear only in ready or qualified
post-submission responses.

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
- synthetic Project Discovery and Workflow Audit submissions with no scheduler
  configured
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
unreadable layout, failed inquiry capture, or premature scheduler exposure.
