// Minimal output_schema check for Agent Job results (agent-job §1.3). It covers
// the JSON Schema subset job authors use for summaries: type, required,
// properties (recursively), items and enum. Returns an error string or null.

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function matchesType(expected, value) {
  const actual = typeOf(value);
  const list = Array.isArray(expected) ? expected : [expected];
  return list.some((type) => type === actual || (type === "number" && actual === "integer"));
}

function check(schema, value, at) {
  if (!schema || typeof schema !== "object") return null;
  if (schema.type && !matchesType(schema.type, value)) return `${at}: expected ${[].concat(schema.type).join("|")}`;
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => JSON.stringify(entry) === JSON.stringify(value))) return `${at}: not in enum`;
  if (typeOf(value) === "object") {
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      if (!(key in value)) return `${at}.${key}: required`;
    }
    for (const [key, sub] of Object.entries(schema.properties || {})) {
      if (key in value) {
        const error = check(sub, value[key], `${at}.${key}`);
        if (error) return error;
      }
    }
  }
  if (typeOf(value) === "array" && schema.items) {
    for (let index = 0; index < value.length; index += 1) {
      const error = check(schema.items, value[index], `${at}[${index}]`);
      if (error) return error;
    }
  }
  return null;
}

export function validateOutput(schema, output) {
  if (!schema) return null;
  return check(schema, output, "$");
}
