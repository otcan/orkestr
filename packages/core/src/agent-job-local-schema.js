// A deliberately bounded JSON Schema subset, validated locally. Unsupported
// keywords are refused rather than claiming the serving model enforced them.
import { isDeepStrictEqual } from "node:util";
import { localAdapterError } from "./agent-job-openai-compatible-health.js";

const keys = new Set(["type", "properties", "required", "items", "enum", "additionalProperties", "description", "title"]);
const types = ["object", "array", "string", "integer", "number", "boolean", "null"];
export function checkLocalSchema(schema, depth = 0) {
  const fail = () => { throw localAdapterError("local_schema_unsupported", { kind: "task" }); };
  if (!schema || typeof schema !== "object" || Array.isArray(schema) || depth > 12 || Object.keys(schema).some(key => !keys.has(key))) fail();
  if (schema.type !== undefined && ![].concat(schema.type).every(type => types.includes(type))) fail();
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some(key => typeof key !== "string"))) fail();
  if (schema.enum !== undefined && !Array.isArray(schema.enum)) fail();
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") fail();
  if (schema.properties !== undefined && (!schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties))) fail();
  for (const sub of Object.values(schema.properties || {})) checkLocalSchema(sub, depth + 1);
  if (schema.items !== undefined) checkLocalSchema(schema.items, depth + 1);
}

export function localSchemaMatches(schema, value) {
  const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  if (schema.type && ![].concat(schema.type).some(type => type === actual || type === "integer" && Number.isInteger(value))) return false;
  if (schema.enum && !schema.enum.some(entry => isDeepStrictEqual(entry, value))) return false;
  if (actual === "object") {
    if ((schema.required || []).some(key => !Object.hasOwn(value, key))) return false;
    for (const key of Object.keys(value)) {
      if (Object.hasOwn(schema.properties || {}, key)) { if (!localSchemaMatches(schema.properties[key], value[key])) return false; }
      else if (schema.additionalProperties === false) return false;
    }
  }
  if (actual === "array" && schema.items && !value.every(item => localSchemaMatches(schema.items, item))) return false;
  return true;
}
