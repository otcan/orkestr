// Export, import, and delete-all. Import is all-or-nothing: a file is fully
// validated and merged in memory first, and existing data is only replaced
// when the browser confirms the combined log was saved.
import { LIMITS, exportLog, localDateString, mergeSets, parseLog } from "./progression.js";

const nothingImported = "Nothing was imported; your existing data is unchanged.";

export async function readImportFile(file, currentSets) {
  if (!file) throw new Error(`No file was selected. ${nothingImported}`);
  if (file.size > LIMITS.importBytes) {
    throw new Error(`This file is ${(file.size / 1024 / 1024).toFixed(1)} MB; a workout log export is at most ${LIMITS.importBytes / 1024 / 1024} MB. ${nothingImported}`);
  }
  const text = await file.text();
  if (!text.trim()) throw new Error(`This file is empty. ${nothingImported}`);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`This file is not valid JSON. ${nothingImported}`);
  }
  let parsed;
  try {
    parsed = parseLog(data, { strict: true });
  } catch (error) {
    throw new Error(`${error.message.replace(/ Nothing was imported\.$/, "")} ${nothingImported}`);
  }
  const { sets, added } = mergeSets(currentSets, parsed.log.sets);
  if (sets.length > LIMITS.maxSets) throw new Error(`Importing would exceed ${LIMITS.maxSets} sets. ${nothingImported}`);
  return { sets, added, total: parsed.log.sets.length };
}

export function initDataPanel({ $, store, setStatus, onChange, onCleared }) {
  const status = $("wl-data-status");
  const input = $("wl-import");
  let importing = false;

  $("wl-export").addEventListener("click", () => {
    const blob = new Blob([exportLog(store.log)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `workout-log-${localDateString()}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus(status, `Exported ${store.log.sets.length} sets to a file on this device. Keep it somewhere safe; it is your backup.`);
  });

  input.addEventListener("change", async () => {
    const file = input.files && input.files[0];
    input.value = "";
    if (!file || importing) return;
    importing = true;
    try {
      const { sets, added, total } = await readImportFile(file, store.log.sets);
      if (!store.save({ ...store.log, sets })) {
        throw new Error(`This browser could not save the import (storage full or blocked). ${nothingImported}`);
      }
      setStatus(status, `Imported ${added} new sets (${total - added} already present).`);
      onChange();
    } catch (error) {
      setStatus(status, error.message, true);
    } finally {
      importing = false;
    }
  });

  $("wl-delete-all").addEventListener("click", () => {
    if (!window.confirm("Delete every logged set and setting from this browser? This cannot be undone. Export first if you want a backup.")) return;
    store.clear();
    onCleared();
    setStatus(status, "All workout data was deleted from this browser.");
  });
}
