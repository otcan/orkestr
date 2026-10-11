import { Module } from "@nestjs/common";
import { SetupsController } from "./setups.controller.js";

@Module({ controllers: [SetupsController] })
export class SetupsModule {}
