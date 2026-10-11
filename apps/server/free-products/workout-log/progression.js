// Pure, dependency-free workout-log logic shared by the browser client and
// the unit tests. Nothing in this module touches the DOM, storage, or network.

export const FORMAT = "orkestr-free-workout-log";
export const VERSION = 1;
export const UNITS = ["kg", "lb"];
export const LB_PER_KG = 2.20462262185;
export const LIMITS = Object.freeze({
  exerciseLength: 60,
  maxReps: 1000,
  maxWeight: 2000,
  maxSets: 20000,
  minRest: 5,
  maxRest: 900,
  importBytes: 2 * 1024 * 1024,
});

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

export function emptyLog() {
  return { format: FORMAT, version: VERSION, settings: { unit: "kg", restSeconds: 90 }, sets: [] };
}

export function cleanExercise(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, LIMITS.exerciseLength);
}

export function exerciseKey(value) {
  return cleanExercise(value).toLowerCase();
}

export function isValidDate(value) {
  if (!datePattern.test(String(value || ""))) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function localDateString(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function roundWeight(value) {
  return Math.round(value * 100) / 100;
}

// Returns a normalized set or throws an Error with a user-readable message.
export function normalizeSet(input, defaults = {}) {
  const exercise = cleanExercise(input?.exercise);
  if (!exercise) throw new Error("Enter an exercise name.");
  const reps = Number(input?.reps);
  if (!Number.isInteger(reps) || reps < 1 || reps > LIMITS.maxReps) throw new Error(`Reps must be a whole number from 1 to ${LIMITS.maxReps}.`);
  const weightText = input?.weight === "" || input?.weight === undefined || input?.weight === null ? "0" : input.weight;
  const weight = Number(weightText);
  if (!Number.isFinite(weight) || weight < 0 || weight > LIMITS.maxWeight) throw new Error(`Weight must be between 0 and ${LIMITS.maxWeight}.`);
  const unit = UNITS.includes(input?.unit) ? input.unit : (UNITS.includes(defaults.unit) ? defaults.unit : "kg");
  const date = isValidDate(input?.date) ? input.date : (defaults.date || localDateString());
  const id = typeof input?.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(input.id) ? input.id : (defaults.id || newId());
  const loggedAt = typeof input?.loggedAt === "string" && !Number.isNaN(Date.parse(input.loggedAt)) ? new Date(input.loggedAt).toISOString() : (defaults.loggedAt || new Date().toISOString());
  return { id, date, exercise, reps, weight: roundWeight(weight), unit, loggedAt };
}

export function newId() {
  const random = Math.random().toString(36).slice(2, 10);
  return `s${Date.now().toString(36)}${random}`;
}

export function convertWeight(weight, from, to) {
  if (from === to) return weight;
  return from === "lb" ? weight / LB_PER_KG : weight * LB_PER_KG;
}

export function setVolume(set, unit = set.unit) {
  return convertWeight(set.weight, set.unit, unit) * set.reps;
}

// Heavier weight wins; equal weight is broken by more reps.
export function compareSets(a, b, unit = "kg") {
  const weightA = convertWeight(a.weight, a.unit, unit);
  const weightB = convertWeight(b.weight, b.unit, unit);
  if (Math.abs(weightA - weightB) > 1e-9) return weightA - weightB;
  return a.reps - b.reps;
}

export function bestSet(sets, unit = "kg") {
  let best = null;
  for (const set of sets) if (!best || compareSets(set, best, unit) > 0) best = set;
  return best;
}

export function exerciseNames(sets) {
  const latest = new Map();
  for (const set of sets) {
    const key = exerciseKey(set.exercise);
    const seen = latest.get(key);
    if (!seen || `${set.date}${set.loggedAt}` > `${seen.date}${seen.loggedAt}`) latest.set(key, set);
  }
  return [...latest.values()].sort((a, b) => `${b.date}${b.loggedAt}`.localeCompare(`${a.date}${a.loggedAt}`)).map((set) => set.exercise);
}

// One row per training date for an exercise, oldest first.
export function exerciseHistory(sets, exercise, unit = "kg") {
  const key = exerciseKey(exercise);
  const byDate = new Map();
  for (const set of sets) {
    if (exerciseKey(set.exercise) !== key) continue;
    if (!byDate.has(set.date)) byDate.set(set.date, []);
    byDate.get(set.date).push(set);
  }
  return [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, daySets]) => ({
    date,
    setCount: daySets.length,
    totalReps: daySets.reduce((sum, set) => sum + set.reps, 0),
    volume: roundWeight(daySets.reduce((sum, set) => sum + setVolume(set, unit), 0)),
    best: bestSet(daySets, unit),
  }));
}

// Compares the latest session volume with the mean of up to `window` earlier sessions.
export function volumeTrend(history, window = 3, tolerance = 0.05) {
  if (history.length < 2) return { direction: "insufficient", change: 0 };
  const latest = history[history.length - 1].volume;
  const previous = history.slice(-1 - window, -1);
  const baseline = previous.reduce((sum, row) => sum + row.volume, 0) / previous.length;
  if (baseline === 0) return { direction: latest > 0 ? "up" : "flat", change: 0 };
  const change = (latest - baseline) / baseline;
  const direction = change > tolerance ? "up" : change < -tolerance ? "down" : "flat";
  return { direction, change: Math.round(change * 1000) / 1000 };
}

export function exerciseSummary(sets, exercise, unit = "kg") {
  const history = exerciseHistory(sets, exercise, unit);
  const allSets = sets.filter((set) => exerciseKey(set.exercise) === exerciseKey(exercise));
  return {
    exercise: cleanExercise(exercise),
    sessions: history.length,
    best: bestSet(allSets, unit),
    history,
    trend: volumeTrend(history),
  };
}

export function formatWeight(set, unit) {
  const value = roundWeight(convertWeight(set.weight, set.unit, unit));
  return value === 0 ? "bodyweight" : `${value} ${unit}`;
}

export function formatSet(set, unit) {
  return `${formatWeight(set, unit)} × ${set.reps}`;
}

export function formatClock(totalSeconds) {
  const seconds = Math.max(0, Math.ceil(totalSeconds));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function clampRest(value) {
  const seconds = Math.round(Number(value));
  if (!Number.isFinite(seconds)) return 90;
  return Math.min(LIMITS.maxRest, Math.max(LIMITS.minRest, seconds));
}

export function normalizeSettings(input) {
  return {
    unit: UNITS.includes(input?.unit) ? input.unit : "kg",
    restSeconds: clampRest(input?.restSeconds ?? 90),
  };
}

// Validates parsed JSON (export file or stored state). Throws on a wrong format.
// Stored state is parsed leniently (bad entries are dropped); imports use
// `strict` so a file with any invalid entry is rejected as a whole.
export function parseLog(data, { strict = false } = {}) {
  if (!data || typeof data !== "object" || data.format !== FORMAT) throw new Error("This file is not a workout log export.");
  if (data.version !== VERSION) throw new Error("This export uses an unsupported version.");
  if (!Array.isArray(data.sets)) throw new Error("The export has no list of sets.");
  if (data.sets.length > LIMITS.maxSets) throw new Error(`The export has more than ${LIMITS.maxSets} sets.`);
  const settings = normalizeSettings(data.settings);
  const sets = [];
  const ids = new Set();
  let skipped = 0;
  for (const raw of data.sets) {
    try {
      const set = normalizeSet(raw, { unit: settings.unit });
      if (!isValidDate(raw?.date) || ids.has(set.id)) throw new Error("invalid");
      ids.add(set.id);
      sets.push(set);
    } catch {
      skipped += 1;
    }
  }
  if (strict && skipped) throw new Error(`${skipped} of ${data.sets.length} entries in this file are invalid or duplicated. Nothing was imported.`);
  return { log: { format: FORMAT, version: VERSION, settings, sets }, skipped };
}

export function mergeSets(current, incoming) {
  const byId = new Map(current.map((set) => [set.id, set]));
  let added = 0;
  for (const set of incoming) {
    if (byId.has(set.id)) continue;
    byId.set(set.id, set);
    added += 1;
  }
  const sets = [...byId.values()].sort((a, b) => `${a.date}${a.loggedAt}`.localeCompare(`${b.date}${b.loggedAt}`));
  return { sets, added };
}

export function exportLog(log, now = new Date()) {
  return JSON.stringify({ format: FORMAT, version: VERSION, exportedAt: now.toISOString(), settings: normalizeSettings(log.settings), sets: log.sets }, null, 2);
}
