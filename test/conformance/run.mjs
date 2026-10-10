#!/usr/bin/env node
// Run the adapter conformance suite against one harness module:
//
//   node test/conformance/run.mjs ./path/to/my-adapter-harness.js [exportName]
//
// The module must export a conformance definition
// ({ name, capabilities, gaps, create }) as `exportName`, `default`, or as the
// only export with a `create` function. Prints the capability matrix at the end.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runConformanceSuite } from "./suite.js";

const [modulePath, exportName] = process.argv.slice(2);
if (!modulePath) {
  process.stderr.write("usage: node test/conformance/run.mjs <harness-module> [exportName]\n");
  process.exit(2);
}
const loaded = await import(pathToFileURL(path.resolve(modulePath)).href);
const candidates = Object.values(loaded).filter((value) => typeof value?.create === "function");
const definition = exportName ? loaded[exportName] : loaded.default?.create ? loaded.default : candidates.length === 1 ? candidates[0] : null;
if (!definition) {
  process.stderr.write(`could not pick a conformance definition from ${modulePath}; pass the export name\n`);
  process.exit(2);
}
process.env.ORKESTR_CONFORMANCE_REPORT ||= "1";
runConformanceSuite(definition);
