import type { BrowsersController } from "./browsers.controller.js";

// Preserve the existing controller's authorization, sanitization and readiness
// checks while keeping ownership of the temporary viewing lease explicit.
export async function prepareOwnerDesktopShare(
  controller: Pick<BrowsersController, "acquireDesktop" | "shareDesktop" | "releaseDesktop">,
  request: any, response: any, slug: string, body: Record<string, unknown>,
) {
  const threadId = String(body.threadId || "").trim();
  const acquired = await controller.acquireDesktop(request, slug, {
    threadId, mode: "exclusive", ttlMs: 60000,
    purpose: "Owner desktop viewing", reuseExisting: true,
  });
  const fencingToken = acquired.lease.fencingToken;
  try {
    return await controller.shareDesktop(request, response, slug, {
      threadId, fencingToken, start: false, ifAbsent: true,
    });
  } finally {
    // A borrowed worker lease is never renewed or released by viewing.
    if (!acquired.borrowed) await controller.releaseDesktop(request, slug, {
      threadId, fencingToken, reason: "owner_share_prepared",
    });
  }
}
