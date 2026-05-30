import { Module } from "@nestjs/common";
import { TenantVmsController } from "./tenant-vms.controller.js";

@Module({
  controllers: [TenantVmsController],
})
export class TenantVmsModule {}
