# Mobile, desktop and reviewer acceptance review

Reviewed 2026-09-25 against `703582a032e31ce61d54d23bfeb0c42f5a4d9abe`.
Scope: ORK-358, ORK-397, ORK-461, ORK-472, ORK-495 and ORK-502.
ORK-499 belongs to the Runtime Delivery workstream and is excluded.

This is a code and automated acceptance review, not release certification.
No deployment, production mutation, provider action or physical-device test was
performed. No ticket should be closed from these results alone.

## Findings requiring follow-up

1. **ORK-358: readiness can be bypassed before share creation.** In
   `apps/server/src/modules/browsers/browsers.controller.ts`, `shareDesktop`
   runs both `openVirtualBrowser` and `desktopShareReady` only when
   `body.start !== false`. An authorized request with `start: false` reaches
   `createDesktopShare` without a readiness result. Skipping startup must still
   require an independent readiness probe. Add an endpoint regression asserting
   that an unhealthy desktop cannot mint a share with startup disabled.
2. **ORK-358: live PIDs are not process identity checks.**
   `scripts/browserctl.mjs` checks recorded PID liveness, TCP listeners and RFB
   pixels. `runtimePidChecks` does not verify executable identity, port ownership
   or the expected DISPLAY. A reused PID and unrelated listener can satisfy those
   portions of the gate. Existing framebuffer tests intentionally assign the same
   Node PID to every process role; they prove black/white-frame rejection, not
   process attribution. Add controlled process-identity and wrong-display
   fixtures before claiming the full readiness contract.
3. **ORK-358: single-active scope differs from the ticket.**
   `test/desktop-shares.test.js` explicitly expects two current shares for the
   same owner and desktop when thread lineages differ. The ticket asks for one
   pending share per owner/desktop. Resolve this contract discrepancy before
   changing lineage behavior; do not silently remove intentional isolation.
4. **ORK-397: the active entry flow differs from signed-link acceptance.**
   `createGoogleWorkspaceReviewEnvironmentLink` returns `/review/google` and
   requires password configuration. The controller's legacy-ticket route redirects
   to that login page. Signed-ticket helper tests do not prove signed entry into
   the current HTTP surface. Either restore the requested expiring signed-entry
   journey or explicitly revise acceptance for the current password flow.
5. **ORK-461: content acceptance is incomplete.** English and localized solution
   templates contain problems, outcomes, process, boundaries and booking links,
   but no dedicated service FAQs or approved customer case-study evidence.
   The `proofText` fields describe approach, not measured customer results.
   Expand the service-specific content and obtain publication permission plus
   attributable outcome evidence before adding customer proof. Product demos
   cannot substitute for that evidence.

These findings are based on the reviewed code and tests. They were not exercised
against a live desktop or reviewer environment. This review does not change the
runtime implementation or the intentionally separate desktop-proxy workstream.

## Acceptance disposition

| Ticket | Local evidence | Still required |
| --- | --- | --- |
| ORK-358 | Black/white RFB rejection, share supersession, concurrent creation and expired-link UI tests pass | Resolve readiness and scope findings; attended, current-thread lease-bound noVNC opening, recovery and old-challenge rejection; final response delivery evidence |
| ORK-397 | Reviewer access, ticket helpers, session revocation, HTTP boundaries, action confirmation and audit tests pass | Resolve entry-flow discrepancy; disposable isolated environment, callback allowlist, reviewer-controlled consent, confirmed Gmail/Calendar actions and teardown evidence |
| ORK-461 | Commercial page rendering tests pass | Service FAQs/content expansion and approved, measurable customer case studies |
| ORK-472 | Device proofs, pairing/auth, routing rejection, durable turn correlation and local HTTP/SSE contract tests pass | Real owner-device pairing, voice turn, reconnect and concurrent-turn acceptance; client sign-off; no profile rebinding or Vagent retirement inferred |
| ORK-495 | Eager uploads, draft claims/idempotency, cancellation, encrypted preview authorization and mobile UI tests pass | Physical iPhone/Android selection/paste/keyboard/retry/reload/Send; authorized release, synthetic deployed claim/cleanup canary and rollback evidence |
| ORK-502 | Signature dispatch, archive safety, actual synthetic PDF pixels, corrupt PDF rejection, rendering limits and lifecycle tests pass | Physical iPhone/Android format/navigation/focus/rotation checks; complete password-protected and large-document device matrix; authorized release and rollback evidence |

## Reproducible local validation

Install locked dependencies with browser downloads and lifecycle scripts disabled:

```sh
PUPPETEER_SKIP_DOWNLOAD=1 npm ci --ignore-scripts --no-audit --no-fund
npm run build:server
env -i PATH="$PATH" HOME=/tmp node --import ./test/test-bootstrap.mjs \
  --test --test-concurrency=2 \
  test/desktop-visual-readiness.test.js test/desktop-shares.test.js \
  test/desktop-share-expiry-ui.test.js test/reviewer-browser-session.test.js \
  test/google-workspace-review-access.test.js \
  test/google-workspace-review-environment.test.js \
  test/google-workspace-review-audit.test.js \
  test/google-workspace-review-http.test.js test/google-workspace-review-ui.test.js \
  test/mobile-devices.test.js test/hush-voice.test.js \
  test/hush-voice-controller.test.js test/hush-device-management-ui.test.js \
  test/mobile-voice-contract.test.js test/draft-attachments.test.js \
  test/draft-upload-browser.test.js test/mobile-attachment-ux.test.js \
  test/attachment-preview-worker.test.js test/attachment-preview-lifecycle.test.js \
  test/attachment-visual-lifecycle.test.js test/attachment-pdf-preview.test.js \
  test/attachment-encryption-api.test.js test/public-commercial-site.test.js
npm run oss:boundary-check
git diff --check
```

Results: server build passed; 128 tests passed, zero failures and zero skips;
OSS boundary check passed. The test bootstrap creates temporary storage, and the
empty inherited environment prevents deployment flags and credentials affecting
the fixtures. No desktop-proxy test or source file was changed. Full CI, tenant
suite, web build and physical-device qualification were not rerun in this review.
