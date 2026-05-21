import { Module } from "@nestjs/common";
import { ConnectorCallbacksController, ConnectorsController, GoogleMarketingCallbacksController } from "./connectors.controller.js";

@Module({
  controllers: [ConnectorsController, ConnectorCallbacksController, GoogleMarketingCallbacksController],
})
export class ConnectorsModule {}
