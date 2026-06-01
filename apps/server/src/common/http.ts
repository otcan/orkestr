import { HttpException } from "@nestjs/common";

export function httpError(message: string, statusCode: number): HttpException {
  return new HttpException({ error: message }, statusCode);
}

export function ensureAttachmentsArray(body: Record<string, unknown> | null | undefined): void {
  if (body && body.attachments !== undefined && !Array.isArray(body.attachments)) {
    throw httpError("attachments must be an array", 400);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function acceptsType(schema: Record<string, unknown>, value: unknown): boolean {
  const type = String(schema["type"] || "").trim();
  if (!type) return true;
  if (type === "string") return ["string", "number", "boolean"].includes(typeof value);
  if (type === "boolean") return typeof value === "boolean" || ["true", "false", "1", "0", "yes", "no", "on", "off"].includes(String(value).trim().toLowerCase());
  if (type === "number" || type === "integer") return typeof value === "number" || (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)));
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isPlainObject(value);
  return true;
}

function validateObjectSection(schema: Record<string, unknown> | undefined, value: unknown, label: string): void {
  if (!schema) return;
  const target = value === undefined || value === null ? {} : value;
  if (!isPlainObject(target)) throw httpError(`${label} must be an object`, 400);
  const required = Array.isArray(schema["required"]) ? schema["required"].map(String) : [];
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(target, key)) throw httpError(`${label}.${key} is required`, 400);
  }
  const properties = isPlainObject(schema["properties"]) ? schema["properties"] : {};
  if (schema["additionalProperties"] === false) {
    const allowed = new Set(Object.keys(properties));
    for (const key of Object.keys(target)) {
      if (!allowed.has(key)) throw httpError(`${label}.${key} is not allowed`, 400);
    }
  }
  for (const [key, propertySchema] of Object.entries(properties)) {
    if (!Object.prototype.hasOwnProperty.call(target, key)) continue;
    if (!isPlainObject(propertySchema)) continue;
    const fieldValue = target[key];
    if (!acceptsType(propertySchema, fieldValue)) {
      throw httpError(`${label}.${key} must be ${propertySchema["type"]}`, 400);
    }
    if (propertySchema["type"] === "array" && Array.isArray(fieldValue) && isPlainObject(propertySchema["items"])) {
      for (const [index, item] of fieldValue.entries()) {
        if (!acceptsType(propertySchema["items"] as Record<string, unknown>, item)) {
          throw httpError(`${label}.${key}[${index}] must be ${(propertySchema["items"] as Record<string, unknown>)["type"]}`, 400);
        }
      }
    }
  }
}

export function validateRequestSchema(
  schema: Record<string, unknown>,
  request: { params?: unknown; body?: unknown; query?: unknown; querystring?: unknown },
): void {
  validateObjectSection(schema["params"] as Record<string, unknown> | undefined, request.params, "params");
  validateObjectSection(schema["body"] as Record<string, unknown> | undefined, request.body, "body");
  validateObjectSection(schema["querystring"] as Record<string, unknown> | undefined, request.querystring ?? request.query, "query");
}
