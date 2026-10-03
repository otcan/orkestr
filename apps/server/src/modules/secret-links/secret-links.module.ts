import { Module } from "@nestjs/common";
import { SecretLinkPagesController } from "./secret-link-pages.controller.js";
import { SecretLinksController } from "./secret-links.controller.js";

@Module({
  controllers: [SecretLinksController, SecretLinkPagesController],
})
export class SecretLinksModule {}
