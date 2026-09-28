import { Module } from "@nestjs/common";
import { ProviderQuotaController } from "./provider-quota.controller.js";

@Module({ controllers: [ProviderQuotaController] })
export class ProviderQuotaModule {}
