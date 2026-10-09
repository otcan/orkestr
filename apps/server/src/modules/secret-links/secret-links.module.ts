import { Module } from "@nestjs/common";
import { SecretLinkPagesController } from "./secret-link-pages.controller.js";
import { SecretLinksController } from "./secret-links.controller.js";
import { VaultSharePagesController } from "./vault-share-pages.controller.js";

@Module({
  controllers: [SecretLinksController, SecretLinkPagesController, VaultSharePagesController],
})
export class SecretLinksModule {}
