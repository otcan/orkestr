import { Module } from "@nestjs/common";
import { VaultAgentController } from "./vault-agent.controller.js";
import { VaultController } from "./vault.controller.js";

@Module({ controllers: [VaultAgentController, VaultController] })
export class VaultModule {}
