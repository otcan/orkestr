import { Module } from "@nestjs/common";
import { ConnectorCallbacksController, ConnectorsController, GoogleMarketingCallbacksController, GoogleWorkspaceConnectController } from "./connectors.controller.js";

@Module({
  controllers: [ConnectorsController, ConnectorCallbacksController, GoogleWorkspaceConnectController, GoogleMarketingCallbacksController],
})
export class ConnectorsModule {}
