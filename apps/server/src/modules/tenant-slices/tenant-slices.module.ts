import { Module } from "@nestjs/common";
import { TenantSlicesController } from "./tenant-slices.controller.js";

@Module({
  controllers: [TenantSlicesController],
})
export class TenantSlicesModule {}
