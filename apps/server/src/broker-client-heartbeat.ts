import {
  brokerClientHeartbeatConfigured,
  brokerClientHeartbeatIntervalMs,
  brokerClientHeartbeatStartupDelayMs,
  sendBrokerClientHeartbeat,
} from "../../../packages/core/src/broker-instance-registry.js";
import { reportServerError } from "./watcher-reporting.js";

export function startBrokerClientHeartbeat(env = process.env) {
  if (!brokerClientHeartbeatConfigured(env)) return { close: () => {} };
  const run = () => {
    sendBrokerClientHeartbeat(env).then((result) => {
      if (result?.ok || result?.skipped) return;
      reportServerError(env, {
        source: "server.brokerClientHeartbeat",
        code: result?.reason || "broker_client_heartbeat_failed",
        message: result?.reason || "Broker client heartbeat failed.",
      });
    }).catch((error) => {
      reportServerError(env, {
        source: "server.brokerClientHeartbeat",
        code: "broker_client_heartbeat_failed",
        message: error?.message || String(error),
        error,
      });
    });
  };
  const startupTimer = setTimeout(run, brokerClientHeartbeatStartupDelayMs(env));
  const interval = setInterval(run, brokerClientHeartbeatIntervalMs(env));
  startupTimer.unref?.();
  interval.unref?.();
  return {
    close: () => {
      clearTimeout(startupTimer);
      clearInterval(interval);
    },
  };
}
