import { Module } from "@nestjs/common";
import { ConnectorCallbacksController, ConnectorsController, GoogleMarketingCallbacksController, GoogleWorkspaceConnectController } from "./connectors.controller.js";
import { GoogleWorkspaceReviewController } from "./google-workspace-review.controller.js";
import { WhatsAppDiagnosticsController } from "./whatsapp-diagnostics.controller.js";

@Module({
  controllers: [ConnectorsController, ConnectorCallbacksController, GoogleWorkspaceConnectController, GoogleWorkspaceReviewController, GoogleMarketingCallbacksController, WhatsAppDiagnosticsController],
})
export class ConnectorsModule {}
