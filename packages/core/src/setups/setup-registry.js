// Built-in Setup registry. Phase A ships one preview Setup; manifests are
// validated when the registry is read so a broken manifest never installs.
import { assertValidSetupManifest } from "./setup-manifest.js";
import { fitnessTrackerManifest } from "./manifests/fitness-tracker.js";

const builtInManifests = [fitnessTrackerManifest];

export function listSetupManifests() {
  return builtInManifests.map((manifest) => assertValidSetupManifest(manifest));
}

export function getSetupManifest(setupId) {
  const manifest = builtInManifests.find((entry) => entry.id === String(setupId || "").trim());
  if (!manifest) {
    const error = new Error("setup_not_found");
    error.statusCode = 404;
    throw error;
  }
  return assertValidSetupManifest(manifest);
}

export function setupManifestSummary(manifest) {
  return {
    id: manifest.id,
    version: manifest.version,
    status: manifest.status,
    title: manifest.title,
    summary: manifest.summary,
    providers: manifest.requires.providers.anyOf,
    channels: manifest.requires.channels,
    alwaysOn: manifest.requires.platform.alwaysOn,
    permissions: manifest.permissions.map((permission) => permission.id),
    timers: manifest.timers.map(({ key, label, cadence, time }) => ({ key, label, cadence, time })),
  };
}
