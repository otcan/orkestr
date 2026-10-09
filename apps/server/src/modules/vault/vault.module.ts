import { Module } from "@nestjs/common";
import { VaultAgentController } from "./vault-agent.controller.js";
import { VaultFillController } from "./vault-fill.controller.js";
import { VaultController } from "./vault.controller.js";

@Module({ controllers: [VaultAgentController, VaultFillController, VaultController] })
export class VaultModule {}
