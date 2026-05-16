import { Module } from "@nestjs/common";
import { ConnectorCallbacksController, ConnectorsController } from "./connectors.controller.js";

@Module({
  controllers: [ConnectorsController, ConnectorCallbacksController],
})
export class ConnectorsModule {}
