import { Module } from "@nestjs/common";
import { UsersController } from "./users.controller.js";
import { UsersOnboardingController } from "./users-onboarding.controller.js";

@Module({
  controllers: [UsersController, UsersOnboardingController],
})
export class UsersModule {}
