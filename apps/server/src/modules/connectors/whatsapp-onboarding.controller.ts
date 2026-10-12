import { Body, Controller, HttpCode, Post, Req } from "@nestjs/common";
import { readWhatsAppConnectorAccounts } from "../../../../../packages/connectors/src/whatsapp-account-registry.js";
import { assertWhatsAppBridgeTokenContext } from "../../../../../packages/connectors/src/whatsapp-binding-acl.js";
import {
  PrivateChatError,
  bindThreadToPrivateOwnerChat,
  pairedAccountForPrivateChat,
  privateChatRequest,
} from "../../../../../packages/connectors/src/whatsapp-onboarding-private-chat.js";
import { getWhatsAppStatus } from "../../../../../packages/connectors/src/whatsapp.js";
import { requestPrincipal } from "../../../../../packages/core/src/principal.js";
import { getThreadForPrincipal } from "../../../../../packages/core/src/threads.js";
import { httpError } from "../../common/http.js";

// First-run wizard only. Kept apart from POST api/connectors/whatsapp/thread-groups,
// whose default-participant behaviour serves other callers and is unchanged.
@Controller("api/connectors/whatsapp/onboarding")
export class WhatsAppOnboardingController {
  @Post("private-chat")
  @HttpCode(200)
  async privateChat(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    try {
      const input = privateChatRequest(body);
      const principal = requestPrincipal(request);
      const thread = await getThreadForPrincipal(input.threadId, principal);
      if (!thread) throw httpError("thread_not_found", 404);
      const paired = pairedAccountForPrivateChat(await getWhatsAppStatus(), input, {
        principal,
        registeredAccounts: await readWhatsAppConnectorAccounts(process.env),
        env: process.env,
      });
      assertWhatsAppBridgeTokenContext("manage", { accountId: paired.accountId }, request.orkestrMachineAuthContext, null, { requireScopedSelector: true });
      return await bindThreadToPrivateOwnerChat(thread, { ...paired, name: input.name }, process.env);
    } catch (error: any) {
      if (error instanceof PrivateChatError) throw httpError(error.code, error.statusCode);
      throw error;
    }
  }
}
