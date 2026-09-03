import { requestThreadInputDelivery } from "./runtime-leases.js";
import {
  enqueueThreadInputForPrincipal,
  getThread,
  getThreadForPrincipal,
  listThreadMessages,
} from "./threads.js";
import { processApiAgentThreadInput, threadUsesApiAgent } from "./tenant-api-agent.js";
import { appendEvent } from "../../storage/src/store.js";
import {
  processVagentRequest as processRequest,
  vagentSpeech,
  waitForVagentFinal as waitForFinal,
} from "./vagent-runtime.js";

const dependencies = {
  appendEvent,
  enqueueThreadInputForPrincipal,
  getThread,
  getThreadForPrincipal,
  listThreadMessages,
  now: () => Date.now(),
  processApiAgentThreadInput,
  requestThreadInputDelivery,
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  threadUsesApiAgent,
};

export { vagentSpeech };

export function waitForVagentFinal(threadId, parentMessageId, timeoutMs, overrides = {}, env = process.env) {
  return waitForFinal(threadId, parentMessageId, timeoutMs, { ...dependencies, ...overrides }, env);
}

export function processVagentRequest(request, options = {}) {
  return processRequest(request, {
    ...options,
    dependencies: { ...dependencies, ...(options.dependencies || {}) },
  });
}
