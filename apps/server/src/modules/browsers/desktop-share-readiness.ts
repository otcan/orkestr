import { listBrowserSessions, openVirtualBrowser } from "../../../../../packages/browsers/src/browsers.js";
import { assertDesktopLeaseForOperation } from "../../../../../packages/browsers/src/desktop-leases.js";
import { assertDesktopAccess } from "../../../../../packages/core/src/desktop-access.js";
import { httpError } from "../../common/http.js";
import { desktopShareNotReadyReason, desktopShareReady } from "./desktop-warning-response.js";

export async function readyDesktopForShare(slug: string, options: any, context: any, env = process.env) {
  const authorize = () => assertDesktopAccess({ ...options, desktopSlug: slug, permission: "share" }, env);
  const decision = await authorize();
  const leaseOptions = { ...options, authorizedBreakGlass: decision.breakGlass === true };
  const lease = await assertDesktopLeaseForOperation(slug, env, leaseOptions);
  let browser: any;
  try {
    if (context.startRequested) {
      // One lifecycle attempt only: browserctl start performs its existing
      // degraded-state repair and returns the post-start readiness result.
      // Never add a second restart/recovery loop here.
      browser = await openVirtualBrowser(slug, env, "", options);
    } else {
      // Inventory only, with no cached success and no prepare/start/repair.
      const inventory = await listBrowserSessions({ ...env, ORKESTR_BROWSER_SESSIONS_CACHE_MS: "0" }, {
        ...options, publicProjection: false,
      });
      if (inventory.ok === false) throw new Error(inventory.error || "desktop_inventory_unavailable");
      const matches = (inventory.sessions || []).filter((item: any) => String(item.slug || item.id) === slug);
      browser = matches.length === 1 ? matches[0] : null;
    }
  } catch (error) {
    // Preserve authorization/lease errors raised by the lifecycle adapter.
    const status = Number((error as any)?.statusCode || 503);
    throw httpError(String((error as Error)?.message || "desktop_readiness_failed"), status, context);
  }
  // The probe can outlive a lease or grant. Recheck before minting the link.
  const current = await authorize();
  await assertDesktopLeaseForOperation(slug, env, {
    ...leaseOptions, authorizedBreakGlass: current.breakGlass === true,
    expectedLeaseId: lease?.id, expectedFencingVersion: lease?.fencingVersion,
  });
  if (!desktopShareReady(browser)) throw httpError(desktopShareNotReadyReason(browser), 503, context);
  return browser;
}
