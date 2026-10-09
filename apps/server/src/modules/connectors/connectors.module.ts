import { Module } from "@nestjs/common";
import { ConnectorCallbacksController, ConnectorsController, GoogleMarketingCallbacksController, GoogleWorkspaceConnectController } from "./connectors.controller.js";
import { GoogleWorkspaceReviewController } from "./google-workspace-review.controller.js";
import { TwilioVoiceController } from "./twilio-voice.controller.js";
import { WhatsAppDiagnosticsController } from "./whatsapp-diagnostics.controller.js";
import { WhatsAppParticipantIdentityController } from "./whatsapp-participant-identity.controller.js";
import { WhatsAppOutboxMaintenanceController } from "./whatsapp-outbox-maintenance.controller.js";

@Module({
  controllers: [ConnectorsController, ConnectorCallbacksController, GoogleWorkspaceConnectController, GoogleWorkspaceReviewController, GoogleMarketingCallbacksController, WhatsAppDiagnosticsController, WhatsAppParticipantIdentityController, WhatsAppOutboxMaintenanceController, TwilioVoiceController],
})
export class ConnectorsModule {}
