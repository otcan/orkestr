import fs from "node:fs/promises";
import { createAndBindWhatsAppThreadGroup } from "../../packages/connectors/src/whatsapp-thread-groups.js";
import { getThread } from "../../packages/core/src/threads.js";

const [home, mode, marker] = process.argv.slice(2);
const env = { ...process.env, ORKESTR_HOME: home };
const thread = await getThread("cross-process-group-thread", env);

try {
  await createAndBindWhatsAppThreadGroup(thread, {
    ownerUserId: "owner",
    instanceId: "instance-fixture",
    responderAccountId: "sender",
  }, env, mode === "create"
    ? {
        createChat: async (input) => {
          await fs.writeFile(marker, "dispatched\n");
          await new Promise((resolve) => setTimeout(resolve, 120));
          await input.onGroupCreated({ chatId: "cross-process-group@g.us", resultKind: "group_id", resultFingerprint: "f".repeat(64) });
          return { chat: { id: "cross-process-group@g.us", name: input.name }, responderAccountId: "sender" };
        },
      }
    : {
        reconcileOperation: async () => {
          await new Promise((resolve) => setTimeout(resolve, 220));
          return { authoritative: false, source: "no_authoritative_evidence" };
        },
      });
} catch (error) {
  // The delayed reconciler can legitimately surface the provisional outcome.
  if (mode !== "reconcile") throw error;
}
