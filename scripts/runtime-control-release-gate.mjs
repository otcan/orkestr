#!/usr/bin/env node
import fs from "node:fs/promises";
import { evaluateRuntimeControlReleaseGate } from "../packages/core/src/observability.js";
import { isMainModule } from "./main-module.mjs";

function inputPath(argv = process.argv.slice(2)) {
  const index = argv.indexOf("--input");
  return index >= 0 ? String(argv[index + 1] || "").trim() : "";
}

export async function runRuntimeControlReleaseGate({ argv = process.argv.slice(2), env = process.env } = {}) {
  const path = inputPath(argv);
  const raw = path
    ? await fs.readFile(path, "utf8")
    : String(env.ORKESTR_RUNTIME_CONTROL_GATE_INPUT_JSON || "{}");
  const input = JSON.parse(raw);
  const gate = evaluateRuntimeControlReleaseGate(input, env);
  return {
    gate: "runtime_control_liveness",
    generatedAt: new Date().toISOString(),
    ...gate,
  };
}

if (isMainModule(import.meta.url)) {
  runRuntimeControlReleaseGate()
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exitCode = result.ok ? 0 : 1;
    })
    .catch((error) => {
      process.stderr.write(`${JSON.stringify({ ok: false, gate: "runtime_control_liveness", error: error?.message || String(error) })}\n`);
      process.exitCode = 2;
    });
}
