import { createRequire } from "node:module";

const { json: expressJson } = createRequire(import.meta.url)("express");

// Scoped JSON parser for POST /api/vault/import: the import content limit is
// 2 MB of text, which can grow when JSON-escaped. The core enforces the 2 MB
// content cap; this only lifts the transport limit for this one route.
export function vaultImportJsonBodyParser() {
  const parser = expressJson({ limit: "5mb" });
  // Nest identifies its built-in parsers by function name; keep this distinct.
  return function vaultImportScopedJsonParser(request: any, response: any, next: any) {
    if (String(request?.method || "").toUpperCase() !== "POST") return next();
    return parser(request, response, next);
  };
}
