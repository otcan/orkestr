import { Module } from "@nestjs/common";
import { EventsSummaryController } from "./events-summary.controller.js";
import { PerfController } from "./perf.controller.js";

@Module({
  controllers: [PerfController, EventsSummaryController],
})
export class PerfModule {}
