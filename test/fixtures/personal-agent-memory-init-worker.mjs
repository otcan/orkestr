import { openPersonalAgentMemoryService } from "../../packages/core/src/personal-agent-memory-sqlite.js";
import { memoryInput, memoryOwnerRequest as owner } from "./personal-agent-memory-store.js";

process.send({ ready: true });
process.once("message", async () => {
  try {
    const service = await openPersonalAgentMemoryService({ ownerUserId: "owner-fixture" });
    const proposal = service.propose(memoryInput(), owner);
    console.log(JSON.stringify(service.create(proposal, owner, { action: "remember", digest: proposal.digest })));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally { process.disconnect(); }
});
