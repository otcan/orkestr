import { createRequire } from "node:module";

const { json: expressJson } = createRequire(import.meta.url)("express");

export function mobileJsonBodyParser() {
  const parser = expressJson({
    limit: "100kb",
    verify(request: any, _response: any, buffer: Buffer) {
      if (Buffer.isBuffer(buffer)) request.rawBody = buffer;
    },
  });
  // Nest identifies its built-in parsers by function name. Keep this wrapper's
  // name distinct so registering a scoped early parser does not suppress the
  // normal global JSON parser during app initialization.
  return function mobileScopedJsonParser(request: any, response: any, next: any) {
    return parser(request, response, next);
  };
}
