import { Module } from "@nestjs/common";
import { VagentController } from "./vagent.controller.js";
import { VagentService } from "./vagent.service.js";

@Module({
  controllers: [VagentController],
  providers: [VagentService],
})
export class VagentModule {}
