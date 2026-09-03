import { Injectable } from "@nestjs/common";
import { processVagentRequest } from "../../../../../packages/core/src/vagent.js";

@Injectable()
export class VagentService {
  process(request: {
    prompt: string;
    sessionId: string;
    principal: Record<string, unknown>;
  }) {
    return processVagentRequest(request);
  }
}
