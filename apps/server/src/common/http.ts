import { HttpException } from "@nestjs/common";

export function httpError(message: string, statusCode: number, extra: Record<string, unknown> = {}): HttpException {
  return new HttpException({ error: message, ...extra }, statusCode);
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
  if (schema["strict"] === true) {
    if (type === "integer") return typeof value === "number" && Number.isInteger(value);
    if (type === "string" || type === "boolean" || type === "number") return typeof value === type;
    if (type === "array") return Array.isArray(value);
    if (type === "object") return isPlainObject(value);
  }
  if (type === "string") return ["string", "number", "boolean"].includes(typeof value);
  if (type === "boolean") return typeof value === "boolean" || ["true", "false", "1", "0", "yes", "no", "on", "off"].includes(String(value).trim().toLowerCase());
  if (type === "number" || type === "integer") return typeof value === "number" || (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)));
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isPlainObject(value);
  return true;
}

function validateValue(schema: Record<string, unknown>, value: unknown, label: string): void {
  if (!acceptsType(schema, value)) throw httpError(`${label} must be ${schema["type"]}`, 400);
  const type = String(schema["type"] || "").trim();
  if (type === "string") {
    const length = String(value).length;
    if (typeof schema["minLength"] === "number" && length < schema["minLength"]) {
      throw httpError(`${label} must be at least ${schema["minLength"]} characters`, 400);
    }
    if (typeof schema["maxLength"] === "number" && length > schema["maxLength"]) {
      throw httpError(`${label} must be at most ${schema["maxLength"]} characters`, 400);
    }
  }
  if (Array.isArray(schema["enum"]) && !schema["enum"].some((allowed) => allowed === value)) {
    throw httpError(`${label} is invalid`, 400);
  }
  if (type === "object") validateObjectSection(schema, value, label);
  if (type === "array" && Array.isArray(value) && isPlainObject(schema["items"])) {
    for (const [index, item] of value.entries()) {
      validateValue(schema["items"] as Record<string, unknown>, item, `${label}[${index}]`);
    }
  }
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
    validateValue(propertySchema, target[key], `${label}.${key}`);
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
