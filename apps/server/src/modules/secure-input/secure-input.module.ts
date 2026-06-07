import { Module } from "@nestjs/common";
import { SecureInputController } from "./secure-input.controller.js";

@Module({
  controllers: [SecureInputController],
})
export class SecureInputModule {}
