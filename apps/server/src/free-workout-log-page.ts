import type { PublicPage } from "./public-site-config.js";

export const workoutLogPath = "/free/workout-log";
export const workoutLogTitle = "Free Workout Log – No Signup, No Data Uploads";
export const workoutLogSummary = "Log exercises, sets, reps, and weight, run a rest timer, and see progress per exercise. No account. After this page loads, it sends nothing back: no analytics, no data uploads.";

// Registered through the public-site catalog and rendered inside the shared
// shell (an umbrella "free" page, so the shell adds no analytics beacon). The
// page loads only its own stylesheet and module; free-products-static.ts adds
// a strict CSP for this route and serves those files.
export function workoutLogPage(): PublicPage {
  return {
    id: "free",
    title: workoutLogTitle,
    summary: workoutLogSummary,
    canonicalPath: workoutLogPath,
    body: `<link rel="stylesheet" href="/free/workout-log/app.css">
  <main id="main-content" class="wl-app wl-main">
    <section class="wl-intro" aria-labelledby="wl-title">
      <p class="wl-eyebrow">Free product · no signup</p>
      <h1 id="wl-title">Workout log</h1>
      <p>Log sets, run a rest timer, and see progress per exercise. After this page loads, it sends nothing back: no analytics, no data uploads. Your entries stay in this browser on this device, and browser storage can be lost; <a href="#wl-storage-notice">keep an export as a backup</a>.</p>
      <ul class="wl-facts" aria-label="How this tool handles your data">
        <li>No account</li><li>No analytics</li><li>No data uploads after the page loads</li><li>Works offline after the first visit</li>
      </ul>
      <p id="wl-storage-warning" class="wl-warning" hidden>This browser blocks local storage (for example in some private modes). You can use the log, but it is lost when the tab closes; export before leaving.</p>
      <noscript><p class="wl-warning">The workout log needs JavaScript. It runs entirely in your browser.</p></noscript>
    </section>

    <section class="wl-card" aria-labelledby="wl-log-title">
      <h2 id="wl-log-title">Log a set</h2>
      <form id="wl-set-form" novalidate>
        <div class="wl-fields">
          <label class="wl-field">Date<input id="wl-date" type="date" required></label>
          <label class="wl-field wl-wide">Exercise<input id="wl-exercise" type="text" list="wl-exercise-list" maxlength="60" autocomplete="off" autocapitalize="sentences" placeholder="e.g. Squat" required></label>
          <div class="wl-field"><label for="wl-weight">Weight</label><div class="wl-weight"><input id="wl-weight" type="text" inputmode="decimal" placeholder="0 = bodyweight" aria-describedby="wl-weight-hint"><select id="wl-unit" aria-label="Weight unit"></select></div><span id="wl-weight-hint" class="visually-hidden">Leave empty or enter 0 for bodyweight exercises.</span></div>
          <label class="wl-field">Reps<input id="wl-reps" type="number" inputmode="numeric" min="1" max="1000" step="1" required></label>
        </div>
        <datalist id="wl-exercise-list"></datalist>
        <label class="wl-check"><input id="wl-autorest" type="checkbox" checked> Start the rest timer after each set</label>
        <button class="wl-primary" type="submit">Add set</button>
        <p id="wl-form-status" role="status" aria-live="polite"></p>
      </form>
    </section>

    <section class="wl-card" aria-labelledby="wl-timer-title">
      <h2 id="wl-timer-title">Rest timer</h2>
      <p id="wl-timer-display" class="wl-timer" aria-hidden="true">1:30</p>
      <div class="wl-presets" aria-label="Start a preset rest">
        <button type="button" data-rest="60">1:00</button><button type="button" data-rest="90">1:30</button><button type="button" data-rest="120">2:00</button><button type="button" data-rest="180">3:00</button>
      </div>
      <label class="wl-rest-field">Default rest (seconds)<input id="wl-rest-seconds" type="number" inputmode="numeric" min="5" max="900" step="5"></label>
      <div class="wl-row">
        <button id="wl-timer-start" type="button">Start</button>
        <button id="wl-timer-add" type="button" disabled>+15 s</button>
        <button id="wl-timer-stop" type="button" disabled>Stop</button>
      </div>
      <p id="wl-timer-status" role="status" aria-live="polite"></p>
    </section>

    <section class="wl-card" aria-labelledby="wl-day-title">
      <h2 id="wl-day-title" tabindex="-1">Sets on <span id="wl-day-label"></span></h2>
      <div id="wl-day-list"></div>
      <p id="wl-day-empty">No sets logged for this date yet.</p>
    </section>

    <section class="wl-card" aria-labelledby="wl-progress-title">
      <h2 id="wl-progress-title">Progress per exercise</h2>
      <label class="wl-field">Exercise<select id="wl-progress-exercise"></select></label>
      <p id="wl-progress-empty">Log a set to see your best set and volume trend.</p>
      <div id="wl-progress-body" hidden>
        <dl class="wl-summary">
          <div><dt>Best set</dt><dd id="wl-best-set"></dd></div>
          <div><dt>Dates logged</dt><dd id="wl-session-count"></dd></div>
          <div><dt>Latest volume</dt><dd id="wl-latest-volume"></dd></div>
          <div class="wl-wide"><dt>Volume trend</dt><dd id="wl-trend"></dd></div>
        </dl>
        <div class="wl-table-wrap">
          <table>
            <caption class="visually-hidden">History per date, newest first. Volume is weight × reps summed over all sets.</caption>
            <thead><tr><th scope="col">Date</th><th scope="col">Sets</th><th scope="col">Best set</th><th scope="col">Volume</th></tr></thead>
            <tbody id="wl-progress-rows"></tbody>
          </table>
        </div>
      </div>
    </section>

    <section class="wl-card" aria-labelledby="wl-data-title">
      <h2 id="wl-data-title">Your data</h2>
      <p><span id="wl-set-count">0</span> sets are stored in this browser.</p>
      <div class="wl-notice" id="wl-storage-notice">
        <strong>Browser storage can be lost.</strong>
        <p>Your log exists only in this browser on this device. It is gone if you clear site data or browsing history, use a private or incognito window, switch to another browser or device, or if the browser frees up space. Export a JSON file regularly as your backup; import it here or on another device to restore. Importing adds sets from the file and never changes or removes the sets already here.</p>
      </div>
      <div class="wl-row">
        <button id="wl-export" type="button">Export JSON</button>
        <input id="wl-import" class="visually-hidden" type="file" accept="application/json,.json">
        <label class="wl-button" for="wl-import">Import JSON</label>
        <button id="wl-delete-all" class="wl-danger" type="button">Delete all data</button>
      </div>
      <p id="wl-data-status" role="status" aria-live="polite"></p>
    </section>

    <section class="wl-disclaimer" aria-labelledby="wl-note-title">
      <h2 id="wl-note-title">Please note</h2>
      <p>This is a simple logging tool. It does not give training, health, or medical advice, and its numbers are plain arithmetic on what you enter (volume = weight × reps). After this page loads, it sends nothing back: no analytics, no data uploads. Like any web page, its own files (page, scripts, styles) are downloaded from our server and may be re-downloaded to pick up updates; your entries are never part of those requests. Because your entries stay only in this browser, export a backup if it matters to you.</p>
    </section>
  </main>
  <script type="module" src="/free/workout-log/app.js"></script>`,
  };
}
