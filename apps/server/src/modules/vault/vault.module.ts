import { Module } from "@nestjs/common";
import { VaultAgentController } from "./vault-agent.controller.js";
import { VaultController } from "./vault.controller.js";
import { VaultRequestsController } from "./vault-requests.controller.js";

@Module({ controllers: [VaultAgentController, VaultController, VaultRequestsController] })
export class VaultModule {}
