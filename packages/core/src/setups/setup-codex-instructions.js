// Codex threads do not apply the standing mission per turn (that path is
// Claude-only). For threads created by a Setup, the Setup's instructions are
// passed as Codex developer instructions when the Codex thread starts.
// Other Codex threads are unchanged.
import { sanitizeStandingMissionText } from "../claude-standing-mission.js";

export function setupDeveloperInstructions(thread = {}, env = process.env) {
  if (!String(thread.setupInstanceId || "").trim()) return "";
  const mission = sanitizeStandingMissionText(thread.standingMission, env);
  return mission ? `Instructions from the installed Orkestr Setup (${thread.setupId || "setup"}):\n${mission}` : "";
}
