import { Module } from "@nestjs/common";
import { BrokerController } from "./broker.controller.js";

@Module({
  controllers: [BrokerController],
})
export class BrokerModule {}
