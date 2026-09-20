import { dataPaths } from "../../storage/src/paths.js";
import { withStorageFileLock } from "../../storage/src/storage-lock.js";

// Single-host JSON/SQLite writers and retention use the same lock. Postgres
// continues to use its row transactions; cross-host retention is not supported.
export function withConnectorOutboxMutation(env, operation) {
  return withStorageFileLock(`${dataPaths(env).connectorOutbox}.mutation`, operation);
}
