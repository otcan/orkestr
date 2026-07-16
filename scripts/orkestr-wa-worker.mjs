#!/usr/bin/env node
import { runOrkestrWaService } from "./orkestr-wa-service.mjs";

process.env.ORKESTR_WA_WORKER_SOCKET ||= "/run/orkestr-wa/sender.sock";

runOrkestrWaService(process.env).catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
