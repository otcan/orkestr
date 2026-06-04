import { Module } from "@nestjs/common";
import { AgentsModule } from "./modules/agents/agents.module.js";
import { BrowsersModule } from "./modules/browsers/browsers.module.js";
import { CodexModule } from "./modules/codex/codex.module.js";
import { ConnectorsModule } from "./modules/connectors/connectors.module.js";
import { GmailNotificationsModule } from "./modules/gmail-notifications/gmail-notifications.module.js";
import { SystemModule } from "./modules/system/system.module.js";
import { ThreadsModule } from "./modules/threads/threads.module.js";
import { TimersModule } from "./modules/timers/timers.module.js";
import { TenantVmsModule } from "./modules/tenant-vms/tenant-vms.module.js";
import { UsersModule } from "./modules/users/users.module.js";

@Module({
  imports: [
    SystemModule,
    CodexModule,
    ConnectorsModule,
    GmailNotificationsModule,
    BrowsersModule,
    AgentsModule,
    ThreadsModule,
    TimersModule,
    TenantVmsModule,
    UsersModule,
  ],
})
export class AppModule {}
