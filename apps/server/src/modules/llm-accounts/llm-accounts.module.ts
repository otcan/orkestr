import { Module } from "@nestjs/common";
import { LlmAccountsController } from "./llm-accounts.controller.js";

@Module({ controllers: [LlmAccountsController] })
export class LlmAccountsModule {}
