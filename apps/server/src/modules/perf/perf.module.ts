import { Module } from "@nestjs/common";
import { PerfController } from "./perf.controller.js";

@Module({
  controllers: [PerfController],
})
export class PerfModule {}
