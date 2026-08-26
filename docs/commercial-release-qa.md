# Commercial Repositioning Release QA

Release scope: ORK-433 and ORK-434 through ORK-444.

## Changed surfaces

- Public positioning, information architecture, responsive visual system, and navigation
- Workflow Pilot intake, qualification, persistence, rate limiting, and notification routing
- Synthetic Console proof and supporting use-case, security, deployment, and developer pages
- Public metadata, sitemap, redirects, event allowlist, and legal disclosures
- Dependency floors for Angular, Nest, MCP, Multer, Puppeteer, and WhatsApp's embedded Puppeteer path

The authenticated app host, secure connect host, personal beta intake, connector authorization,
and private deployment overlays remain separate surfaces.

## Pre-release evidence

| Gate | Result |
| --- | --- |
| `npm run check` | 2,109 tests; 2,103 pass; 6 opt-in/environment skips; 0 failures |
| Production server and web builds | Pass; initial web bundle 1.19 MB raw / 251.63 kB estimated transfer |
| High-risk attachment, virtual-file, use-control, WhatsApp, outbox, and recovery suite | 482/482 pass |
| Public route, host-separation, form, notification, and architecture suite | 52/52 pass after the module split |
| `npm audit --json` | 0 vulnerabilities at every severity |
| `npm run oss:boundary-check` | Pass; 634 public files scanned |
| `git diff --check` | Pass |

The six aggregate-suite skips require external or opt-in infrastructure and are not assertions
against this release. Attended real WhatsApp delivery was not selected: repository policy treats
it as an optional diagnostic, while the local bridge, embedded Puppeteer, routing, outbox, and
recovery paths are covered by the 482-test high-risk gate.

## Route and conversion checks

An isolated production build served the following paths with HTTP 200 and their dedicated title:

- `/`, `/workflow`, `/use-cases`, `/security`, `/deployment`, `/developers`, `/beta`
- `/privacy`, `/terms`, and `/support`

`/waitlist` returns HTTP 302 to `/beta#waitlist`. The sitemap returns HTTP 200 with all 12 public
routes. Host-separation tests verify that commercial pages remain on the configured public host,
while the application and pairing flows retain their own hosts.

The Workflow Pilot tests cover required fields, consent, qualification, duplicate suppression,
spam timing and honeypot checks, allowlisted analytics, separate storage from personal beta,
notification routing, and the scheduling-link gate. No synthetic lead was sent to a production
mailbox during release QA.

## Responsive and accessibility checks

The site was exercised in the managed Android emulator at 1080 × 2400 physical pixels and 420 dpi.
The homepage, control diagram, Workflow Pilot page and form, and personal beta page stack without
horizontal page overflow. Header actions remain reachable through the phone menu, form controls
remain full width, and the approval boundary is readable without zooming.

DOM checks at the intermediate 800 CSS-pixel viewport confirmed no document overflow across every
commercial route, a `main#main-content` landmark, route-specific titles and headings, visible native
validation errors, and a 2px-or-greater focus outline with offset. The only intentionally off-canvas
elements are the Workflow Pilot honeypot fields. Wide deployment comparison content stays inside an
explicit horizontal table scroller rather than widening the page.

Automated Lighthouse scoring was not recorded during pre-release QA because the managed Android
Chrome instance stopped exposing its DevTools socket after the density restart. Performance risk is
bounded by the production bundle measurement, server-rendered commercial HTML, code-native diagrams,
no stock media, no third-party analytics script, and the complete browser build. Run an external
production URL audit after deployment when the scoring service is available; this exception does not
permit a routing, accessibility, security, or conversion failure.

## Claims review

- “AI Operations Layer” is presented as a coordination and control model, not autonomous replacement.
- “Managed private deployment” is explicit; the site does not claim a public hosted SaaS offering.
- Approval, connector, provider, retention, and deployment limitations are disclosed.
- The Console example is labelled synthetic and deployment-specific; no customer logo or result is implied.
- OSS capabilities are described as public alpha and separated from private configuration and operations.

## Rollback and post-launch checks

Use the release train's recorded prior release id:

```bash
orkestr rollback --to <previous-release-id>
```

After deployment, verify the public homepage and `/workflow`, confirm `/beta` still contains the
personal waitlist, confirm the app and connect hosts retain their responsibilities, and verify the
no-cookie private-API exposure gate. Monitor server errors, Workflow Pilot storage/notification
status, and public event volume. Roll back on host crossover, form loss, private API exposure,
broken app authentication, or a sustained rise in server errors.
