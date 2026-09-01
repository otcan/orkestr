import { Module } from "@nestjs/common";
import { AttachmentEncryptionController } from "./attachment-encryption.controller.js";

@Module({ controllers: [AttachmentEncryptionController] })
export class AttachmentEncryptionModule {}
