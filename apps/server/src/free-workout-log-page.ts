import { escapeHtml, publicCanonicalUrl } from "./public-site-config.js";

export const workoutLogTitle = "Free Workout Log – No Signup, Stays in Your Browser";
export const workoutLogSummary = "Log exercises, sets, reps, and weight, run a rest timer, and see progress per exercise. No account, no tracking; data stays in this browser.";

// Standalone page: it deliberately skips the shared site shell so it loads no
// event beacon or other script besides its own same-origin module.
export function renderWorkoutLogPage(env = process.env) {
  const canonical = publicCanonicalUrl("/free/workout-log", env);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>${escapeHtml(workoutLogTitle)} | Orkestr</title>
  <meta name="description" content="${escapeHtml(workoutLogSummary)}">
  <meta name="robots" content="index,follow">
  <meta name="theme-color" content="#f2efe6">
  <meta name="referrer" content="no-referrer">
  ${canonical ? `<link rel="canonical" href="${escapeHtml(canonical)}">` : ""}
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link rel="stylesheet" href="/free/workout-log/app.css">
  <script type="module" src="/free/workout-log/app.js"></script>
</head>
<body>
  <a class="skip-link" href="#main-content">Skip to content</a>
  <header class="wl-top">
    <a class="wl-brand" href="/">Orkestr</a>
    <nav aria-label="Free products"><a href="/free">Free products</a></nav>
  </header>
  <main id="main-content" class="wl-main">
    <section class="wl-intro" aria-labelledby="wl-title">
      <p class="wl-eyebrow">Free product · no signup</p>
      <h1 id="wl-title">Workout log</h1>
      <p>Log sets, run a rest timer, and see progress per exercise. Your log is stored in this browser on this device and is never uploaded.</p>
      <ul class="wl-facts" aria-label="How this tool handles your data">
        <li>No account</li><li>No tracking or analytics</li><li>No network calls with your data</li><li>Works offline after the first visit</li>
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
      <h2 id="wl-day-title">Sets on <span id="wl-day-label"></span></h2>
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
      <p><span id="wl-set-count">0</span> sets are stored in this browser. Export a JSON file as a backup or to move to another device; importing merges the sets from such a file.</p>
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
      <p>This is a simple logging tool. It does not give training, health, or medical advice, and its numbers are plain arithmetic on what you enter (volume = weight × reps). Clearing site data or using another browser or device removes access to the log, so export a backup if it matters to you.</p>
    </section>
  </main>
  <footer class="wl-footer">
    <a href="/free">Free products</a><a href="/">Orkestr</a><a href="/impressum">Imprint</a><a href="/privacy">Privacy</a>
  </footer>
</body>
</html>`;
}
