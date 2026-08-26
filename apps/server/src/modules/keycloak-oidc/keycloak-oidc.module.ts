import { Module } from "@nestjs/common";
import { KeycloakOidcController } from "./keycloak-oidc.controller.js";

@Module({
  controllers: [KeycloakOidcController],
})
export class KeycloakOidcModule {}
