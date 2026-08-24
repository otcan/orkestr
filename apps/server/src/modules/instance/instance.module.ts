import { Module } from "@nestjs/common";
import { InstanceController } from "./instance.controller.js";

@Module({ controllers: [InstanceController] })
export class InstanceModule {}
