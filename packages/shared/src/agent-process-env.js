// Control-plane encryption keys must never become credentials of an agent or
// its tools. Copy at the spawn boundary so the parent can still decrypt records.
export function agentProcessEnv(env = process.env) {
  const result = { ...env };
  delete result.ORKESTR_CONNECTOR_ENCRYPTION_KEY;
  delete result.ORKESTR_SECRET_KEY;
  delete result.ORKESTR_SECURE_INPUT_KEY;
  return result;
}
