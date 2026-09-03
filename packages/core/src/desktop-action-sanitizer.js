import { assertSanitizedAction } from "./llm-sanitizer.js";
import { isAdminPrincipal } from "./policy.js";
import { getThreadForPrincipal } from "./threads.js";
import { userScopedCapabilityHints } from "./user-skills.js";

const clean = (value = "") => String(value || "").trim();

export async function assertDesktopActionSanitized({ action = "action", principal = null, desktopSlug = "", input = {} } = {}, env = process.env) {
  if (isAdminPrincipal(principal || {})) return null;
  const threadId = clean(input?.threadId || input?.ownerThreadId);
  const thread = threadId ? await getThreadForPrincipal(threadId, principal, env) : null;
  const ownerUserId = clean(thread?.ownerUserId || principal?.userId);
  const capabilities = await userScopedCapabilityHints({ userId: ownerUserId, thread }, env);
  return assertSanitizedAction({
    action: `desktop.${clean(action).toLowerCase() || "action"}`,
    principal,
    resource: {
      type: "desktop",
      id: clean(desktopSlug),
      ownerUserId,
      capabilities,
    },
    input: {
      slug: clean(desktopSlug),
      ...input,
    },
  }, env);
}
