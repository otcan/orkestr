import path from "node:path";
import { ensureDataDirs } from "../../storage/src/paths.js";
import { readJson, writeJson } from "../../storage/src/store.js";

// A local, offline stand-in for a code host's pull request API. Like a real
// code host it does NOT deduplicate on its own: opening twice creates two pull
// requests. Callers find earlier work by the idempotency marker stored on the
// pull request, the same way a real adapter would search by branch or body tag.

async function sinkPath(env) {
  const paths = await ensureDataDirs(env);
  return path.join(paths.home, "simulated", "pull-requests.json");
}

export async function listSimulatedPullRequests(env = process.env) {
  return readJson(await sinkPath(env), []);
}

async function savePullRequests(pullRequests, env) {
  await writeJson(await sinkPath(env), pullRequests);
}

export async function openSimulatedPullRequest({ repository, title, head, idempotencyKey } = {}, env = process.env) {
  const pullRequests = await listSimulatedPullRequests(env);
  const pullRequest = {
    number: pullRequests.length + 1,
    repository: String(repository || "example/repo"),
    title: String(title || "Untitled change"),
    head: String(head || "orkestr/demo"),
    idempotencyKey: String(idempotencyKey || ""),
    state: "open",
    merges: 0,
    openedAt: new Date().toISOString(),
  };
  await savePullRequests([...pullRequests, pullRequest], env);
  return pullRequest;
}

export async function findSimulatedPullRequest(idempotencyKey, env = process.env) {
  const key = String(idempotencyKey || "");
  if (!key) return null;
  return (await listSimulatedPullRequests(env)).find((pullRequest) => pullRequest.idempotencyKey === key) || null;
}

export async function mergeSimulatedPullRequest(number, env = process.env) {
  const pullRequests = await listSimulatedPullRequests(env);
  const index = pullRequests.findIndex((pullRequest) => pullRequest.number === Number(number));
  if (index < 0) throw Object.assign(new Error("pull_request_not_found"), { statusCode: 404 });
  const merged = {
    ...pullRequests[index],
    state: "merged",
    merges: Number(pullRequests[index].merges || 0) + 1,
    mergedAt: new Date().toISOString(),
  };
  pullRequests[index] = merged;
  await savePullRequests(pullRequests, env);
  return merged;
}
