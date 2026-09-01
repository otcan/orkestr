import { buildCiTestEnv } from "../scripts/ci-test-runner.mjs";

if (process.env.ORKESTR_TEST_STORAGE_BOOTSTRAPPED !== "1") {
  const isolated = buildCiTestEnv(process.env);
  for (const key of Object.keys(process.env)) {
    if (!Object.prototype.hasOwnProperty.call(isolated, key)) delete process.env[key];
  }
  Object.assign(process.env, isolated, {
    ORKESTR_TEST_STORAGE_BOOTSTRAPPED: "1",
  });
}
