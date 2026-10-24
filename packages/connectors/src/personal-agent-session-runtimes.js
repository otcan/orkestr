// Compose connector authentication discovery outside core. Missing discovery
// fails closed in the core factory; it never infers subscription readiness.
import { codexLoginStatus } from "./codex.js";
import { createPersonalAgentSessionRuntimes as coreSessionRuntimes } from "../../core/src/personal-agent-session-runtimes.js";

export function createPersonalAgentSessionRuntimes(options = {}) {
  return coreSessionRuntimes({ codexLogin: codexLoginStatus, ...options });
}
