import { Module } from "@nestjs/common";
import { ConnectorCallbacksController, ConnectorsController, GoogleMarketingCallbacksController, GoogleWorkspaceConnectController } from "./connectors.controller.js";
import { WhatsAppDiagnosticsController } from "./whatsapp-diagnostics.controller.js";

@Module({
  controllers: [ConnectorsController, ConnectorCallbacksController, GoogleWorkspaceConnectController, GoogleMarketingCallbacksController, WhatsAppDiagnosticsController],
})
export class ConnectorsModule {}
