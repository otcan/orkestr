# Setup manifest v1 (preview)

A **Setup** is a ready-made automation an owner installs into their own Orkestr,
for example a personal fitness tracker. Phase A ships the contract, an internal
registry with one preview Setup, and `orkestr setup list|status|install|configure|pause|resume|export|uninstall`.
It is not a general one-click installer yet: installs are admin-only, there is
no wizard step, and WhatsApp is never connected by install.

Code: `packages/core/src/setups/`. API: `GET /api/setups`, `GET /api/setups/status`,
`POST /api/setups/:id/install|configure|pause|resume`, `GET /api/setups/:id/export`,
`DELETE /api/setups/:id` (admin only).

## Contract (`schema: "orkestr.setup/v1"`)

| Field | Meaning |
|---|---|
| `id`, `version`, `status` | Lowercase id, semver, `preview` or `stable`. |
| `requires.providers.subscriptionOnly` | Must be `true`. A Setup only runs on the owner's subscription login. A Codex API-key login is refused (`codex_api_key_not_subscription`), so nothing silently bills pay-as-you-go. Claude Code child processes already receive an allowlisted environment, so a host `ANTHROPIC_API_KEY` is not passed through. |
| `requires.providers.anyOf` | AI logins that can run it: `codex` (ChatGPT/Codex login) and/or `claude-code`. Install refuses with `setup_prerequisite_missing` (HTTP 428) if none is signed in, before creating anything. |
| `requires.channels[]` | `web` or `whatsapp`, each `required: true/false` with a plain-language `purpose`. |
| `requires.platform.alwaysOn` | Whether scheduled check-ins need the host running. |
| `permissions[]` | Least privilege. Only ids from the fixed list in `setup-manifest.js`. Each resource the manifest creates needs its permission, and unused permissions are rejected. `whatsapp.reply-owner` must set `grantedByInstall: false`. |
| `thread` | One thread name plus a standing mission (instructions). |
| `timers[]` | Keyed `daily`/`weekly` check-ins (`HH:MM`, owner time zone) that target only the Setup's thread. `defaultEnabled` must be `false`: check-ins start off and are turned on with `--opt-in` at install or `configure --enable`. |
| `state` | `store: "setup-events"`, `schemaVersion`, step-wise `migrations` (N to N+1 only), `onUninstall: retain or delete`. |
| `uninstall.thread` | Only `retire` (restorable). Install and uninstall never hard-delete a conversation. |

## Lifecycle guarantees

- **Owned resources only:** `$ORKESTR_HOME/setups/installs.json` records each instance's thread id, mission flag, timer ids and state directory the moment each is created. Rollback and uninstall act only on those recorded ids.
- **Idempotent install:** an installed instance for the same owner and Setup returns `already_installed` and changes nothing.
- **Rollback:** a failure mid-install undoes recorded resources newest-first (delete timers, clear mission, retire thread) and marks the instance `rolled_back`. If rollback itself fails, the instance is `rollback_failed`, and the next install finishes the cleanup before starting fresh.
- **No adoption:** `createThread` returns an existing thread on a name match. The installer uses a unique id and name, and aborts with `setup_thread_conflict` if it gets back a thread it did not create.
- **Safe uninstall:** a timer the owner has re-pointed at another thread is skipped (`skipped_retargeted`), not deleted. Repeated uninstall returns `not_installed`. State is retained when the manifest says so.
- **Configure, pause, resume:** these change only recorded check-ins that still target the Setup's thread. Unknown or conflicting keys are refused.
- **Export:** returns the configuration, instructions and check-in state without secrets. Records join once the fitness store exists.
- **No WhatsApp on install:** status always reports `whatsapp: not_bound` until the owner binds a chat themselves.

## Known gaps (verified, not fixed in Phase A)

1. **Instructions on Codex:** fixed on this branch. Setup-created threads carry `setupInstanceId`, and Codex receives the Setup mission as `developerInstructions` at thread start (`setup-codex-instructions.js`). Other Codex threads are unchanged. Not yet verified in a real Codex session (backlog P0-01). A mission changed after the Codex thread started only applies to a new Codex thread.
2. **Timer loop overlap:** fixed on this branch. Due-timer passes are serialized per home (`timer-run-guard.js`); the test shows one delivery.
3. **Retry backoff:** fixed on this branch. Failed timers retry after 1 minute, doubling up to 1 hour.
4. **Weekly cadence** repeats seven days after the first run; there is no weekday field.
5. **Thread runtime readiness** of a Setup thread (first real turn on Codex and on Claude Code) is not verified in Phase A.
6. **Single process writer:** the ledger lock is in-process; the CLI goes through the server API.
7. **Owner scope:** admin only. A non-admin path needs the sanitizer review used for `timer.create`.

## Not claimed

No general one-click install, no WhatsApp connection, no "€0 extra" cost, no
unlimited or 24/7 operation, no medical or fitness outcome.
