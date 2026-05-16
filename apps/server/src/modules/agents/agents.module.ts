import { Module } from "@nestjs/common";
import { AgentsController } from "./agents.controller.js";

@Module({
  controllers: [AgentsController],
})
export class AgentsModule {}
