import { Module } from "@nestjs/common";
import { RouterTracesController } from "./router-traces.controller.js";

@Module({
  controllers: [RouterTracesController],
})
export class RouterTracesModule {}
