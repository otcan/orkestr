#!/usr/bin/env node
import { startServer } from "../../server/src/server.js";

const args = new Set(process.argv.slice(2));
const port = Number(process.env.PORT || process.env.ORKESTR_PORT || 19812);
const host = process.env.ORKESTR_HOST || "127.0.0.1";

startServer({ port, host, openBrowser: args.has("--open") }).catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
