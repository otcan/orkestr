import { requestJson } from "./api-client.js";

const PUSH_BRANCH_USAGE = "Usage: orkestr worker push-branch <worker-thread> [--json]";

export async function workerPushBranchCommand(argv, ctx) {
  const json = argv.includes("--json");
  const threadId = argv.find((value) => !value.startsWith("--"));
  if (!threadId) throw new Error(PUSH_BRANCH_USAGE);
  const payload = await requestJson(`/api/threads/${encodeURIComponent(threadId)}/push-branch`, {
    ...ctx,
    method: "POST",
    body: {},
  });
  if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else ctx.stdout.write(`Pushed ${payload.branchName || "branch"} to ${payload.remoteBranch || "origin"}\n`);
  return 0;
}
