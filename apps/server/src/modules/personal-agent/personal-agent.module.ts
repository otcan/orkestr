import { Module } from "@nestjs/common";
import { PersonalAgentController } from "./personal-agent.controller.js";

@Module({ controllers: [PersonalAgentController] })
export class PersonalAgentModule {}
