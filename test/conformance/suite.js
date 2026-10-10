import { after, before, describe, test } from "node:test";
import { CAPABILITIES, normalizeCapabilities } from "./capabilities.js";
import { CHECKS } from "./checks.js";

// Registers the conformance checks for one adapter harness with node:test.
//
//   runConformanceSuite({ name, capabilities, gaps, create });
//
// `capabilities` (string[]) and `gaps` ({ [capability]: reason }) are static so
// skip-vs-run is decided at registration time. `create()` returns (or resolves
// to) an object implementing the harness contract in checks.js, plus optional
// setup()/teardown()/endSession(session) hooks.
export function runConformanceSuite(definition, options = {}) {
  const { name, create } = definition;
  const testTimeoutMs = options.timeoutMs || 20_000;
  const declared = normalizeCapabilities(definition.capabilities || []);
  const gaps = definition.gaps || {};
  const results = [];
  let harness = null;
  let sessionCounter = 0;

  describe(`adapter conformance: ${name}`, () => {
    before(async () => {
      harness = await create();
      await harness.setup?.();
    });

    after(async () => {
      await harness?.teardown?.();
      if (process.env.ORKESTR_CONFORMANCE_REPORT === "1") {
        process.stdout.write(`${formatConformanceMatrix(name, results)}\n`);
      }
    });

    for (const check of CHECKS) {
      const capability = CAPABILITIES[check.capability];
      const supported = declared.has(check.capability);
      if (!supported && capability.required) {
        test(`[${check.capability}] ${check.title}`, () => {
          results.push({ id: check.id, capability: check.capability, outcome: "fail", note: "required capability not declared" });
          throw new Error(`required capability ${check.capability} is not declared by ${name}`);
        });
        continue;
      }
      if (!supported) {
        const note = gaps[check.capability] || "capability not declared";
        results.push({ id: check.id, capability: check.capability, outcome: "skip", note });
        test(`[${check.capability}] ${check.title}`, { skip: note }, () => {});
        continue;
      }
      test(`[${check.capability}] ${check.title}`, { timeout: testTimeoutMs }, async () => {
        sessionCounter += 1;
        const session = await harness.startSession({ sessionKey: `${check.id}-${sessionCounter}` });
        try {
          await check.run(harness, session);
          results.push({ id: check.id, capability: check.capability, outcome: "pass", note: "" });
        } catch (error) {
          results.push({ id: check.id, capability: check.capability, outcome: "fail", note: String(error?.message || error).split("\n")[0] });
          throw error;
        } finally {
          await harness.endSession?.(session);
        }
      });
    }
  });
}

export function formatConformanceMatrix(name, results = []) {
  const lines = [`conformance matrix: ${name}`];
  for (const result of results) {
    lines.push(`  ${result.outcome.padEnd(4)} ${result.id.padEnd(24)} ${result.capability.padEnd(18)} ${result.note}`.trimEnd());
  }
  return lines.join("\n");
}
