# OSS documentation editorial backlog: 16 November–13 December 2026

Status: review backlog. This plan does not publish a website, change a release,
activate a scheduler or qualify an untested product feature. Keep one new asset
in the readiness lane until its public exposure and documentation ownership are
confirmed. The capacity target is two substantial tutorials and one useful
refresh per week; defer an item rather than publish thin or unsupported content.

## Coverage and ownership

The public beta.6 release and `v2/README.md` own the pinned V2 installation
contract. Root README and the commercial site's developer quick start also
contain other installation paths; a reader must not silently combine versions.
The source-build section currently contradicts the prebuilt-image quick start;
refresh that wording without implying that an unqualified source build is a
new public release.

Repository tutorials own developer troubleshooting and reproducible examples.
The existing commercial site owns business service and inquiry intent, as
recorded in [the commercial SEO plan](../commercial-seo-plan.md). Do not clone
its commercial pages into technical keyword pages or start another domain.
The website maintainer must approve a docs route, canonical ownership, navigation
and sitemap inclusion before any repository tutorial is mirrored on that site.
Retain the personal-beta indexing restriction. No domain or hosting purchase is
part of this backlog.

## Four-week queue

Every row is a distinct audience problem. Dates are **review-ready targets**,
not claims of publication or automatic scheduling. Every proposed workflow must
be checked against the public release used by its tutorial. The release CTA is
one accurately named link, not a promise of a completed installation or sale.

| Due (Berlin, 18:00) | Asset and target query | Audience / intent | Original useful component | One CTA |
| --- | --- | --- | --- | --- |
| 16 Nov | Check Docker before installing Orkestr; `Orkestr Docker engine not responding` | Mac/Linux self-hosters; resolve an install blocker | Bounded read-only diagnostic plus a failure decision table | [Open the pinned public release][release] |
| 19 Nov | Connect a model and verify a first conversation; `Orkestr connect Codex first conversation` | New beta users; complete setup | Synthetic greeting/task transcript and a setup-versus-provider acceptance checklist; qualify sign-in manually first | [Open the pinned public release][release] |
| 20 Nov, refresh | V2 quick start clarity; `Orkestr Docker image or source build` | Readers selecting an installation path | Correct the prebuilt/source contradiction and label release-specific setup | [Open the pinned public release][release] |
| 23 Nov | Keep a local conversation across stop/start; `Orkestr Docker persistent data` | Local testers; retain state | Disposable sample conversation and named-volume lifecycle worksheet; no unqualified upgrade/restore claims | [Open the pinned public release][release] |
| 26 Nov | Schedule a synthetic check and inspect its result; `Orkestr scheduled task example` | Self-hosters; understand timers | Fixture-only reminder, schedule/timezone/next-run table, stop/restart behavior; public UI/tool and cadence qualification is a prerequisite | [Open the pinned public release][release] |
| 27 Nov, refresh | Published capability table; `Orkestr beta features` | Evaluators; decide what is supported | Release-linked evidence for tools, timers and browser availability; retain unknown states | [Open the pinned public release][release] |
| 30 Nov | Choose a release or a source checkout; `Orkestr V2 release versus source` | Developers; choose reproducibility versus development | Tag/commit/image worksheet and fictional version-mixing examples; selection intent, not a duplicate install guide | [Open the pinned public release][release] |
| 3 Dec | Diagnose provider-login-required after account setup; `Orkestr provider_login_required` | Existing installers; recover model access | Error-to-layer checklist and synthetic redacted report; no copied account state | [Open the pinned public release][release] |
| 4 Dec, refresh | Troubleshooting index and issue reporting | Readers already stuck; find the correct guide | Link the new diagnostics and show a sanitized fixture report | [Open the pinned public release][release] |
| 7 Dec | Reach a loopback-only test on a remote Linux host; `Orkestr SSH port forwarding` | Technical self-hosters; access their own server | Diagram and localhost-forward example using reserved example domains; test forwarding in an isolated environment first | [Open the pinned public release][release] |
| 10 Dec | Review a proposed task result and stop work; `Orkestr review AI task result` | First-time operators; understand control | Fictional work request with expected review/stop states; test the exact published UI first | [Open the pinned public release][release] |
| 11 Dec, refresh | Release/date/link audit of the tutorial cluster | Returning users; avoid stale steps | Broken-link, version, source-date and CTA audit; update dates only after real review | [Open the pinned public release][release] |

[release]: https://github.com/otcan/orkestr/releases/tag/v2.0.0-beta.6

The next two items after the initial Docker guide are the first-conversation
tutorial (19 November) and the quick-start refresh (20 November). Leave them
queued while the active asset's readiness checks or publication approval are
blocked. Existing engineering milestones and owner holds retain precedence.

## Initial asset record

- Title: [Check Docker before installing Orkestr on Mac or Linux](tutorials/check-docker-before-orkestr.md).
- Target query/audience: `Orkestr Docker engine not responding`; Mac/Linux
  self-hosters who cannot get to account setup.
- Repository route: `docs/v2/tutorials/check-docker-before-orkestr.md`.
- Publication state: draft until the normal branch/PR/review process completes.
  Its exact commit and command receipts belong in the accompanying review record.
- Sources reviewed: 2026-11-15; Docker's official info/context/troubleshooting
  and Linux access references, and the public beta.6 release.
- Website URL: unassigned; no duplicate `/developers` or commercial route created.
- Canonical/indexability: GitHub controls repository-page canonical and robots
  behavior. Search indexing is unknown. No first-party HTML canonical is claimed
  for the draft. A later website rendition needs one approved canonical and a
  verified public response before this lane expands.
- Sitemap: the draft is not a first-party route and is not added to the existing
  website sitemap. Website ownership/review precedes sitemap changes.
- Internal links: V2 README links into the tutorial; the tutorial links back to
  the V2 quick start and install issue template, and onward to the release CTA.
- CTA: public beta.6 release page. Validation must confirm HTTP success and the
  intended tag. GitHub Markdown does not provide a project-controlled click
  event here; event testing is unsupported. Clicks, signups, inquiries, traffic,
  rankings and revenue are unknown.

## Readiness and maintenance loop

At each existing authorized maintenance checkpoint, take the next ready item:

1. Check the engineering milestone and owner holds, then review coverage to avoid
   competing pages with the same intent. Keep at most one active new asset until
   exposure is confirmed.
2. Pin the public release, verify authoritative sources and run the tutorial's
   commands in the appropriate isolated environment. Record actual host coverage
   separately from fixture tests; do not count syntactic checks as a full install.
3. Review examples for confidential data, unsupported capabilities and destructive
   shortcuts. Keep every illustration synthetic and every outcome evidence-based.
4. Follow the normal feature-branch and green-CI review path. Tags, release images
   and public announcements retain their explicit approval gates. Website changes
   require the existing website maintainer; do not deploy another platform.
5. Record URL, commit, draft/live state, source date, links, canonical/robots,
   sitemap decision, CTA test and next due date. Attach exact blockers to drafts.
   Reuse the existing maintenance schedule; this plan creates no timer.

For a future approved website page, use its existing analytics contract for a
metadata-only CTA event, and test that event before claiming it works. Do not add
tracking to a repository Markdown page or infer sales from clicks. There are no
ranking or volume forecasts in this plan.
