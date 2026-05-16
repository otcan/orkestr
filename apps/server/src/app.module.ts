import { Module } from "@nestjs/common";
import { AgentsModule } from "./modules/agents/agents.module.js";
import { BrowsersModule } from "./modules/browsers/browsers.module.js";
import { ConnectorsModule } from "./modules/connectors/connectors.module.js";
import { SystemModule } from "./modules/system/system.module.js";
import { ThreadsModule } from "./modules/threads/threads.module.js";
import { TimersModule } from "./modules/timers/timers.module.js";

@Module({
  imports: [
    SystemModule,
    ConnectorsModule,
    BrowsersModule,
    AgentsModule,
    ThreadsModule,
    TimersModule,
  ],
})
export class AppModule {}
