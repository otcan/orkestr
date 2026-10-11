import assert from "node:assert/strict";
import test from "node:test";
import {
  FORMAT, LIMITS, bestSet, clampRest, compareSets, emptyLog, exerciseHistory, exerciseNames, exerciseSummary,
  exportLog, formatClock, formatSet, mergeSets, normalizeSet, parseLog, setVolume, volumeTrend,
} from "../apps/server/free-products/workout-log/progression.js";
import { STORAGE_KEY, createStore } from "../apps/server/free-products/workout-log/store.js";
import { createRestTimer } from "../apps/server/free-products/workout-log/timer.js";

let counter = 0;
function set(date, exercise, weight, reps, unit = "kg") {
  counter += 1;
  return normalizeSet({ id: `t${counter}`, date, exercise, weight, reps, unit, loggedAt: `${date}T10:00:${String(counter % 60).padStart(2, "0")}.000Z` });
}

test("normalizeSet validates input and treats empty weight as bodyweight", () => {
  const pushUp = normalizeSet({ exercise: "  Push   up ", reps: "12", weight: "", date: "2026-10-01" });
  assert.equal(pushUp.exercise, "Push up");
  assert.equal(pushUp.weight, 0);
  assert.equal(pushUp.reps, 12);
  assert.equal(formatSet(pushUp, "kg"), "bodyweight × 12");
  assert.equal(normalizeSet({ exercise: "Row", reps: 5, weight: "62.555", date: "2026-10-01" }).weight, 62.56);
  assert.throws(() => normalizeSet({ exercise: "", reps: 5 }), /exercise name/);
  assert.throws(() => normalizeSet({ exercise: "Squat", reps: 0 }), /Reps/);
  assert.throws(() => normalizeSet({ exercise: "Squat", reps: 2.5 }), /Reps/);
  assert.throws(() => normalizeSet({ exercise: "Squat", reps: 5, weight: -1 }), /Weight/);
  assert.throws(() => normalizeSet({ exercise: "Squat", reps: 5, weight: "abc" }), /Weight/);
  assert.throws(() => normalizeSet({ exercise: "Squat", reps: 5, weight: LIMITS.maxWeight + 1 }), /Weight/);
  assert.equal(normalizeSet({ exercise: "x".repeat(80), reps: 1 }).exercise.length, LIMITS.exerciseLength);
});

test("best set prefers heavier weight, then more reps, across units", () => {
  const sets = [set("2026-10-01", "Squat", 100, 5), set("2026-10-01", "Squat", 100, 6), set("2026-10-01", "Squat", 95, 10)];
  assert.equal(bestSet(sets).reps, 6);
  assert.equal(bestSet([]), null);
  const kg = set("2026-10-01", "Bench", 100, 3);
  const lb = set("2026-10-01", "Bench", 225, 1, "lb");
  assert.ok(compareSets(lb, kg, "kg") > 0, "225 lb is heavier than 100 kg");
  assert.equal(bestSet([kg, lb], "kg"), lb);
  assert.equal(Math.round(setVolume(lb, "kg") * 100) / 100, 102.06);
});

test("history groups sets per date with volume and best set, case-insensitively", () => {
  const sets = [
    set("2026-10-03", "squat", 105, 5), set("2026-10-01", "Squat", 100, 5), set("2026-10-01", "Squat", 100, 5),
    set("2026-10-01", "Deadlift", 140, 3),
  ];
  const history = exerciseHistory(sets, "SQUAT");
  assert.deepEqual(history.map((row) => [row.date, row.setCount, row.totalReps, row.volume]), [
    ["2026-10-01", 2, 10, 1000],
    ["2026-10-03", 1, 5, 525],
  ]);
  assert.equal(history[1].best.weight, 105);
  assert.deepEqual(exerciseNames(sets), ["squat", "Deadlift"]);
});

test("volume trend compares the latest date with up to three earlier dates", () => {
  const rows = (...volumes) => volumes.map((volume, index) => ({ date: `2026-10-0${index + 1}`, volume }));
  assert.equal(volumeTrend(rows(500)).direction, "insufficient");
  assert.deepEqual(volumeTrend(rows(1000, 1000, 1000, 1200)), { direction: "up", change: 0.2 });
  assert.deepEqual(volumeTrend(rows(9999, 1000, 1000, 1000, 800)), { direction: "down", change: -0.2 });
  assert.equal(volumeTrend(rows(1000, 1020)).direction, "flat");
  assert.equal(volumeTrend(rows(0, 0)).direction, "flat");
  assert.equal(volumeTrend(rows(0, 50)).direction, "up");
});

test("exercise summary combines best set, session count, and trend", () => {
  const sets = [set("2026-10-01", "Press", 40, 8), set("2026-10-02", "Press", 42.5, 8), set("2026-10-02", "Press", 42.5, 8)];
  const summary = exerciseSummary(sets, "press");
  assert.equal(summary.sessions, 2);
  assert.equal(summary.best.weight, 42.5);
  assert.equal(summary.trend.direction, "up");
});

test("export, parse, and merge round-trip without duplicates", () => {
  const log = { ...emptyLog(), settings: { unit: "lb", restSeconds: 120 }, sets: [set("2026-10-01", "Squat", 100, 5)] };
  const text = exportLog(log, new Date("2026-10-11T00:00:00Z"));
  const parsed = parseLog(JSON.parse(text));
  assert.equal(parsed.skipped, 0);
  assert.deepEqual(parsed.log.settings, { unit: "lb", restSeconds: 120 });
  assert.deepEqual(parsed.log.sets, log.sets);
  const merged = mergeSets(log.sets, [...parsed.log.sets, set("2026-09-30", "Row", 60, 10)]);
  assert.equal(merged.added, 1);
  assert.deepEqual(merged.sets.map((item) => item.date), ["2026-09-30", "2026-10-01"]);
});

test("parseLog rejects foreign files and skips invalid entries", () => {
  assert.throws(() => parseLog({ sets: [] }), /not a workout log/);
  assert.throws(() => parseLog({ format: FORMAT, version: 99, sets: [] }), /unsupported version/);
  assert.throws(() => parseLog({ format: FORMAT, version: 1 }), /no list of sets/);
  const { log, skipped } = parseLog({
    format: FORMAT, version: 1, settings: { unit: "stone", restSeconds: 99999 },
    sets: [
      { id: "a1", date: "2026-10-01", exercise: "Squat", reps: 5, weight: 100, unit: "kg" },
      { id: "a1", date: "2026-10-01", exercise: "Squat", reps: 5, weight: 100, unit: "kg" },
      { id: "a2", date: "2026-02-30", exercise: "Squat", reps: 5, weight: 100 },
      { id: "a3", date: "2026-10-01", exercise: "<img src=x>", reps: -1 },
      null,
    ],
  });
  assert.equal(log.sets.length, 1);
  assert.equal(skipped, 4);
  assert.deepEqual(log.settings, { unit: "kg", restSeconds: LIMITS.maxRest });
});

test("clock formatting and rest clamping", () => {
  assert.equal(formatClock(90), "1:30");
  assert.equal(formatClock(0.2), "0:01");
  assert.equal(formatClock(-5), "0:00");
  assert.equal(clampRest(1), LIMITS.minRest);
  assert.equal(clampRest("abc"), 90);
});

test("rest timer counts down from an absolute end time and fires once", () => {
  let now = 1_000_000;
  const ticks = [];
  let done = 0;
  let scheduled = null;
  const timer = createRestTimer({
    now: () => now, schedule: (fn) => { scheduled = fn; return 1; }, cancel: () => { scheduled = null; },
    onTick: (left, running) => ticks.push([Math.ceil(left), running]), onDone: () => { done += 1; },
  });
  timer.start(60);
  assert.equal(timer.running, true);
  now += 30_000;
  scheduled();
  timer.add(15);
  assert.equal(Math.ceil(timer.remaining()), 45);
  now += 45_000;
  scheduled();
  assert.equal(done, 1);
  assert.equal(timer.running, false);
  assert.equal(scheduled, null);
  timer.start(10);
  timer.stop();
  assert.equal(done, 1);
  assert.deepEqual(ticks.at(-1), [0, false]);
});

test("store persists to the provided storage and clears it", () => {
  const backing = new Map();
  const storage = { getItem: (k) => backing.get(k) ?? null, setItem: (k, v) => backing.set(k, v), removeItem: (k) => backing.delete(k) };
  const store = createStore(storage);
  assert.equal(store.persistent, true);
  store.save({ ...emptyLog(), sets: [set("2026-10-01", "Squat", 100, 5)] });
  assert.equal(createStore(storage).log.sets.length, 1);
  backing.set(STORAGE_KEY, "{broken");
  assert.equal(createStore(storage).log.sets.length, 0);
  store.clear();
  assert.equal(backing.has(STORAGE_KEY), false);
  assert.equal(createStore(null).persistent, false);
});
