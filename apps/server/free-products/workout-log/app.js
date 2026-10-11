// Workout log client. Everything runs in this page: no fetch, no XHR, no
// beacons. Data lives in localStorage and leaves only via the user's export.
import {
  LIMITS, UNITS, clampRest, exerciseKey, exerciseNames, exerciseSummary, exportLog, formatClock,
  formatSet, isValidDate, localDateString, mergeSets, normalizeSet, normalizeSettings, parseLog,
} from "./progression.js";
import { STORAGE_KEY, createStore } from "./store.js";
import { createRestTimer } from "./timer.js";

const $ = (id) => document.getElementById(id);
const store = createStore();
const el = (tag, text = "", className = "") => {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
};

const form = $("wl-set-form");
const dateInput = $("wl-date");
const exerciseInput = $("wl-exercise");
const weightInput = $("wl-weight");
const unitSelect = $("wl-unit");
const repsInput = $("wl-reps");
const autoRest = $("wl-autorest");
const formStatus = $("wl-form-status");
const timerDisplay = $("wl-timer-display");
const timerStatus = $("wl-timer-status");
const restInput = $("wl-rest-seconds");
const progressSelect = $("wl-progress-exercise");
const dataStatus = $("wl-data-status");

let selectedExercise = "";

function settings() {
  return normalizeSettings(store.log.settings);
}

function commit(next, statusNode, message) {
  const saved = store.save(next);
  if (statusNode) statusNode.textContent = saved ? message : `${message} Warning: this browser refused to save, so it will be lost when the tab closes.`;
  render();
}

function setStatus(node, message, isError = false) {
  node.textContent = message;
  node.classList.toggle("wl-error", isError);
}

// ---- Logging ---------------------------------------------------------------
form.addEventListener("submit", (event) => {
  event.preventDefault();
  try {
    const set = normalizeSet({
      date: dateInput.value, exercise: exerciseInput.value, weight: weightInput.value.replace(",", "."),
      reps: repsInput.value, unit: unitSelect.value,
    }, { unit: settings().unit });
    if (!isValidDate(dateInput.value)) throw new Error("Choose a valid date.");
    if (store.log.sets.length >= LIMITS.maxSets) throw new Error("The log is full. Export and delete older data first.");
    selectedExercise = set.exercise;
    commit({ ...store.log, settings: { ...settings(), unit: set.unit }, sets: [...store.log.sets, set] }, formStatus, `Added ${set.exercise}: ${formatSet(set, set.unit)}.`);
    formStatus.classList.remove("wl-error");
    if (autoRest.checked) timer.start(settings().restSeconds);
    repsInput.focus();
  } catch (error) {
    setStatus(formStatus, error.message, true);
  }
});

dateInput.addEventListener("change", render);
unitSelect.addEventListener("change", () => {
  if (UNITS.includes(unitSelect.value)) commit({ ...store.log, settings: { ...settings(), unit: unitSelect.value } }, null, "");
});

function deleteSet(id) {
  const set = store.log.sets.find((item) => item.id === id);
  if (!set) return;
  commit({ ...store.log, sets: store.log.sets.filter((item) => item.id !== id) }, formStatus, `Removed one ${set.exercise} set.`);
}

// ---- Rest timer ------------------------------------------------------------
const timer = createRestTimer({
  onTick(left, running) {
    timerDisplay.textContent = formatClock(running ? left : settings().restSeconds);
    timerDisplay.classList.toggle("wl-running", running);
    $("wl-timer-stop").disabled = !running;
    $("wl-timer-add").disabled = !running;
  },
  onDone() {
    timerStatus.textContent = "Rest finished.";
    timerDisplay.classList.add("wl-done");
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  },
});

function updateRest(seconds) {
  const restSeconds = clampRest(seconds);
  restInput.value = String(restSeconds);
  store.save({ ...store.log, settings: { ...settings(), restSeconds } });
  if (!timer.running) timerDisplay.textContent = formatClock(restSeconds);
}

document.querySelectorAll("[data-rest]").forEach((button) => {
  button.addEventListener("click", () => {
    updateRest(button.getAttribute("data-rest"));
    startTimer();
  });
});
restInput.addEventListener("change", () => updateRest(restInput.value));
$("wl-timer-start").addEventListener("click", startTimer);
$("wl-timer-add").addEventListener("click", () => timer.add(15));
$("wl-timer-stop").addEventListener("click", () => {
  timer.stop();
  timerStatus.textContent = "Timer stopped.";
});

function startTimer() {
  timerDisplay.classList.remove("wl-done");
  timerStatus.textContent = `Resting for ${formatClock(settings().restSeconds)}.`;
  timer.start(settings().restSeconds);
}

// ---- Rendering -------------------------------------------------------------
function renderDay() {
  const date = isValidDate(dateInput.value) ? dateInput.value : localDateString();
  const unit = settings().unit;
  const sets = store.log.sets.filter((set) => set.date === date);
  $("wl-day-label").textContent = date;
  $("wl-day-empty").hidden = sets.length > 0;
  const list = $("wl-day-list");
  list.replaceChildren();
  const groups = new Map();
  for (const set of sets) {
    const key = exerciseKey(set.exercise);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(set);
  }
  for (const group of groups.values()) {
    const block = el("div", "", "wl-group");
    block.append(el("h3", group[0].exercise));
    const ol = el("ol");
    group.forEach((set) => {
      const li = el("li");
      li.append(el("span", formatSet(set, unit)));
      const remove = el("button", "Remove", "wl-link");
      remove.type = "button";
      remove.setAttribute("aria-label", `Remove ${set.exercise} set ${formatSet(set, unit)}`);
      remove.addEventListener("click", () => deleteSet(set.id));
      li.append(remove);
      ol.append(li);
    });
    block.append(ol);
    list.append(block);
  }
}

function renderExerciseChoices(names) {
  const datalist = $("wl-exercise-list");
  datalist.replaceChildren(...names.map((name) => Object.assign(document.createElement("option"), { value: name })));
  if (!names.some((name) => exerciseKey(name) === exerciseKey(selectedExercise))) selectedExercise = names[0] || "";
  progressSelect.replaceChildren(...names.map((name) => Object.assign(document.createElement("option"), { value: name, textContent: name })));
  progressSelect.value = names.find((name) => exerciseKey(name) === exerciseKey(selectedExercise)) || "";
  progressSelect.disabled = names.length === 0;
}

const trendText = {
  up: (pct) => `Up ${pct}% vs. the average of the previous sessions`,
  down: (pct) => `Down ${pct}% vs. the average of the previous sessions`,
  flat: () => "About the same as the previous sessions",
  insufficient: () => "Log this exercise on two or more dates to see a trend",
};

function renderProgress() {
  const unit = settings().unit;
  const hasData = Boolean(selectedExercise);
  $("wl-progress-empty").hidden = hasData;
  $("wl-progress-body").hidden = !hasData;
  if (!hasData) return;
  const summary = exerciseSummary(store.log.sets, selectedExercise, unit);
  const latest = summary.history[summary.history.length - 1];
  $("wl-best-set").textContent = summary.best ? `${formatSet(summary.best, unit)} (${summary.best.date})` : "–";
  $("wl-session-count").textContent = String(summary.sessions);
  $("wl-latest-volume").textContent = latest ? `${latest.volume} ${unit}` : "–";
  $("wl-trend").textContent = trendText[summary.trend.direction](Math.abs(Math.round(summary.trend.change * 100)));
  $("wl-trend").dataset.direction = summary.trend.direction;
  const rows = summary.history.slice().reverse().map((row) => {
    const tr = el("tr");
    tr.append(el("td", row.date), el("td", String(row.setCount)), el("td", formatSet(row.best, unit)), el("td", `${row.volume} ${unit}`));
    return tr;
  });
  $("wl-progress-rows").replaceChildren(...rows);
}

function render() {
  const current = settings();
  unitSelect.value = current.unit;
  restInput.value = String(current.restSeconds);
  if (!timer.running) timerDisplay.textContent = formatClock(current.restSeconds);
  renderExerciseChoices(exerciseNames(store.log.sets));
  renderDay();
  renderProgress();
  $("wl-set-count").textContent = String(store.log.sets.length);
}

progressSelect.addEventListener("change", () => {
  selectedExercise = progressSelect.value;
  renderProgress();
});

// ---- Export / import / delete ---------------------------------------------
$("wl-export").addEventListener("click", () => {
  const blob = new Blob([exportLog(store.log)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = el("a");
  link.href = url;
  link.download = `workout-log-${localDateString()}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setStatus(dataStatus, `Exported ${store.log.sets.length} sets to a file on this device.`);
});

$("wl-import").addEventListener("change", async (event) => {
  const input = event.target;
  const file = input.files && input.files[0];
  input.value = "";
  if (!file) return;
  try {
    if (file.size > LIMITS.importBytes) throw new Error("That file is too large to be a workout log export.");
    const { log, skipped } = parseLog(JSON.parse(await file.text()));
    const { sets, added } = mergeSets(store.log.sets, log.sets);
    const skippedText = skipped ? ` ${skipped} invalid entries were skipped.` : "";
    commit({ ...store.log, sets }, dataStatus, `Imported ${added} new sets (${log.sets.length - added} already present).${skippedText}`);
    dataStatus.classList.remove("wl-error");
  } catch (error) {
    setStatus(dataStatus, error instanceof SyntaxError ? "That file is not valid JSON." : error.message, true);
  }
});

$("wl-delete-all").addEventListener("click", () => {
  if (!window.confirm("Delete every logged set and setting from this browser? This cannot be undone. Export first if you want a backup.")) return;
  timer.stop();
  store.clear();
  selectedExercise = "";
  setStatus(dataStatus, "All workout data was deleted from this browser.");
  render();
});

// Keep several open tabs consistent.
window.addEventListener("storage", (event) => {
  if (event.key !== STORAGE_KEY) return;
  store.reload();
  render();
});

// ---- Start -----------------------------------------------------------------
unitSelect.replaceChildren(...UNITS.map((unit) => Object.assign(document.createElement("option"), { value: unit, textContent: unit })));
dateInput.value = localDateString();
$("wl-storage-warning").hidden = store.persistent;
render();
document.documentElement.dataset.ready = "true";

if ("serviceWorker" in navigator && window.isSecureContext) {
  navigator.serviceWorker.register("/free/workout-log-sw.js", { scope: "/free/" }).catch(() => {});
}
