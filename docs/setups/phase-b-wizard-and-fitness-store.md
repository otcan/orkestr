# Draft spec: wizard Setup picker and fitness event store (Phase B)

Status: draft for review. Nothing here is implemented.

## 1. Wizard "Pick a Setup" step

Placement: a new first step in `apps/web/src/app/onboarding-page.component.ts`
goals, and an entry in the first-thread wizard, both calling `/api/setups`.

Flow, one choice at a time:
1. **Pick** a Setup card (title, one-line outcome, what it creates, what it needs).
2. **Sign in** to the AI provider if `setup_prerequisite_missing` (reuse Codex device login and Claude browser login screens). The page states that sign-in uses the owner's own plan and its usage limits.
3. **Confirm permissions**: list the manifest permissions in plain words. WhatsApp is shown as optional and off.
4. **Install**: call `POST /api/setups/:id/install` with the browser time zone. Show created thread and check-in times.
5. **Optional WhatsApp**: a separate, explicit step. Shown only if a WhatsApp account is already paired. It includes the ban-risk notice (see the feasibility note), binds one owner-only chat, and records the `whatsapp.reply-owner` grant on the instance.
6. **Uninstall** from the Setup card: shows exactly what will be removed and what is kept.

Acceptance: a fresh install reaches step 4 without a terminal once Orkestr is
running. Refusals show the plain-language reason. No step binds WhatsApp
implicitly.

## 2. Fitness event store (`setup-events`, schemaVersion 1)

- **Location:** `$ORKESTR_HOME/setups/instances/<instanceId>/events.jsonl` (append-only, 0600), plus `snapshot.json` (derived, rebuildable).
- **Event:** `{ id, at, kind, source, data, supersedes? }`.
  - `kind`: `workout.logged`, `workout.corrected`, `workout.deleted`, `goal.set` or `note`.
  - `source`: `thread` or `import`.
- **`workout.logged` data:** `{ date, exercise, sets?, reps?, weightKg?, distanceKm?, durationMin?, rpe?, note? }`. Units are normalized at write time, and the original text is kept for correction.
- **Writes:** only through a narrow tool the agent calls, `setup.fitness.log`, which validates and appends. The agent never writes files directly. Ambiguous input must come back as a question, not a guess (mission rule).
- **Corrections:** a new event with `supersedes`. Nothing is rewritten in place, so history stays auditable.
- **Migrations:** `migrations[]` steps N to N+1 run at install or upgrade on a copy, then replace atomically. The schema version is recorded in the ledger.
- **Export and delete:** `GET /api/setups/:instanceId/export` returns JSON with all events. Uninstall with `onUninstall: delete`, or an explicit "delete my records", removes the instance directory. Default `retain`.
- **Progress view:** a private page behind Orkestr login. It shows sessions per week, personal bests per exercise, volume trend, and a last-7-days list. It is derived from the snapshot only, and nothing is public.

Acceptance tests (Phase B):
- "squat 3x5 100kg" produces one event, and the snapshot shows the best set.
- An ambiguous message produces no event and one question.
- A correction supersedes the earlier event.
- Export round-trips.
- A migration from v1 to v2 on a copy is atomic.
- Delete removes only that instance directory.

## Out of scope until review

The second Setup (job applications), publishing website pages, SEO, and LinkedIn
beyond drafts.
