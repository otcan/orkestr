import { Injectable } from "@nestjs/common";
import {
  requestThreadInputDelivery,
  runtimeStatus,
} from "../../../../../packages/core/src/runtime-leases.js";
import { assertSanitizedAction } from "../../../../../packages/core/src/llm-sanitizer.js";
import { isAdminPrincipal } from "../../../../../packages/core/src/policy.js";
import {
  enqueueThreadInputForPrincipal,
  getThread,
  updateThread,
} from "../../../../../packages/core/src/threads.js";
import { createThreadWorker, detectThreadRepo, listThreadWorkers, refreshThreadGitState, syncThreadWorkerWithParent, updateThreadRepo } from "../../../../../packages/core/src/thread-workers.js";
import { userScopedCapabilityHints } from "../../../../../packages/core/src/user-skills.js";
import { sanitizedThreadActionInput } from "./thread-route-helpers.js";

@Injectable()
export class ThreadInputService {
  async enqueue(threadId: string, body: Record<string, unknown>, principal: any) {
    const message = await enqueueThreadInputForPrincipal(threadId, body, principal);
    requestThreadInputDelivery(threadId);
    return { message };
  }
}

@Injectable()
export class ThreadRuntimeService {
  status(threadId: string) {
    return runtimeStatus(threadId);
  }
}

@Injectable()
export class ThreadActionSanitizerService {
  async assertAllowed(action: string, principal: any, thread: any, input: Record<string, unknown> = {}) {
    if (isAdminPrincipal(principal)) return null;
    const capabilities = await userScopedCapabilityHints({
      userId: thread?.ownerUserId || principal?.userId || "",
      thread,
    }, process.env);
    return assertSanitizedAction({
      action,
      principal,
      resource: {
        type: "thread",
        id: thread?.id || "",
        ownerUserId: thread?.ownerUserId || principal?.userId || "",
        state: thread?.state || "",
        parentThreadId: thread?.parentThreadId || null,
        rootThreadId: thread?.rootThreadId || null,
        capabilities,
      },
      input: sanitizedThreadActionInput(input),
    }, process.env);
  }
}

@Injectable()
export class ThreadWorkerService {
  list(threadId: string) {
    return listThreadWorkers(threadId);
  }

  create(threadId: string, body: Record<string, unknown>) {
    return createThreadWorker(threadId, body);
  }

  syncParent(threadId: string) {
    return syncThreadWorkerWithParent(threadId);
  }

  refreshGitState(threadId: string) {
    return refreshThreadGitState(threadId);
  }
}

@Injectable()
export class ThreadRepoService {
  detect(threadId: string) {
    return detectThreadRepo(threadId);
  }

  update(threadId: string, body: Record<string, unknown>) {
    return updateThreadRepo(threadId, body);
  }
}

@Injectable()
export class ThreadBindingService {
  async update(threadId: string, binding: Record<string, unknown>) {
    const thread = await getThread(threadId);
    return {
      thread: await updateThread(threadId, {
        binding: {
          ...(thread?.binding || {}),
          ...binding,
        },
      }),
    };
  }

  updateWhatsAppBinding(thread: Record<string, any>, binding: Record<string, unknown>, patch: Record<string, unknown> = {}) {
    return updateThread(thread.id, {
      ...patch,
      binding,
      bindingName: String(binding.displayName || thread.name || thread.id),
    });
  }
}
