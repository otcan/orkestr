import { HttpException } from "@nestjs/common";

export function httpError(message: string, statusCode: number): HttpException {
  return new HttpException({ error: message }, statusCode);
}

export function ensureAttachmentsArray(body: Record<string, unknown> | null | undefined): void {
  if (body && body.attachments !== undefined && !Array.isArray(body.attachments)) {
    throw httpError("attachments must be an array", 400);
  }
}
