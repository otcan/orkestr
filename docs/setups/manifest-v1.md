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

- **One lifecycle at a time:** install, uninstall, configure, pause and resume for the same owner and Setup run one after another (`withSetupLifecycle`). A second install waits and returns `already_installed`; it never mistakes a running install for a crashed one.
- **Owned resources only:** `$ORKESTR_HOME/setups/installs.json` records the instance's thread id and every check-in id *before* each is created (check-ins get the id `<instanceId>-<key>`). Rollback and uninstall act only on these recorded ids, never on "anything targeting the Setup thread": an owner may point their own timers at that thread, and those are never touched. An interrupted install that is retried or uninstalled directly removes exactly its recorded resources (`not_created` when the crash came before creation).
- **Idempotent install:** an installed instance for the same owner and Setup returns `already_installed` and changes nothing.
- **Rollback:** a failure mid-install undoes recorded resources newest-first (delete timers, clear mission, retire thread) and marks the instance `rolled_back`. If rollback itself fails, the instance is `rollback_failed`, and the next install finishes the cleanup before starting fresh.
- **No adoption:** `createThread` returns an existing thread on a name match. The installer uses a unique id and name, and aborts with `setup_thread_conflict` if it gets back a thread it did not create.
- **Safe uninstall:** a timer the owner has re-pointed at another thread is skipped (`skipped_retargeted`), not deleted. Repeated uninstall returns `not_installed`. State is retained when the manifest says so.
- **Configure, pause, resume:** these change only recorded check-ins that still target the Setup's thread. Unknown or conflicting keys are refused. Each check-in keeps the owner's choice (`wanted`). `pause` turns all of them off without forgetting it, `configure` while paused only stores the choice, and `resume` restores exactly the chosen check-ins. Nothing is switched on that the owner did not choose.
- **Export:** returns the configuration, instructions and check-in state without secrets. Records join once the fitness store exists.
- **No WhatsApp on install:** status always reports `whatsapp: not_bound` until the owner binds a chat themselves.

## Known gaps (verified, not fixed in Phase A)

1. **Instructions on Codex:** fixed on this branch. Setup-created threads carry `setupInstanceId`, and Codex receives the Setup mission as `developerInstructions` at thread start (`setup-codex-instructions.js`). Other Codex threads are unchanged. Not yet verified in a real Codex session (backlog P0-01). A mission changed after the Codex thread started only applies to a new Codex thread.
2. **Timer loop overlap:** fixed on this branch. Due-timer passes are serialized per home (`timer-run-guard.js`); the test shows one delivery.
3. **Retry backoff:** fixed on this branch. Failed timers retry after 1 minute, doubling up to 1 hour.
4. **Weekly cadence** repeats seven days after the first run; there is no weekday field.
5. **Thread runtime:** the installer sets the same runtime fields as the thread-create route (`codex-app-server`, or `claude-code` with its account profile) and starts the runtime once, after the instructions and the Setup marker are set. Without that, Setup check-ins were never delivered (found in the P0-01 dry run). Verified with a fake Codex app-server; Claude Code runtime start and any real account are not yet verified.
6. **Delivery and process-local limits:** the lifecycle lock, the ledger write queue and the due-timer pass lock (`timer-run-guard.js`) serialize work only inside one Orkestr server process. Two server processes sharing one `ORKESTR_HOME` are not protected; the CLI goes through the server API, so the supported setup is one server per home. Overlapping due-timer passes are serialized, but duplicates remain possible. If a check-in is enqueued and saving the timer's new state then fails, or the server restarts in between, the same check-in can be delivered again. This patch does not provide exactly-once delivery.
7. **Owner scope:** admin only. A non-admin path needs the sanitizer review used for `timer.create`.
8. **Subscription check at dispatch:** install refuses a Codex API-key login, and every turn of a Setup thread is checked again right before it reaches the provider (`setups/setup-dispatch-guard.js`). This covers scheduled check-ins, owner messages and resumed sessions alike. Codex: the app-server that will run the turn is asked `account/read`; only `type: "chatgpt"` passes. An API key, no login, an unknown type or a failed check refuses the turn: the input is marked failed with the reason (`codex_api_key_not_subscription`, `codex_not_logged_in`, `codex_auth_mode_not_subscription`, `codex_auth_state_unavailable`) and is not retried. Claude Code: the account profile must be `authMode: "subscription"`, the child process may not carry `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` or Bedrock/Vertex switches, and the installed CLI's own `claude auth status --json` (verified on Claude Code 2.1.295), run with the exact command, child environment and working directory of the turn (project-local settings such as an `apiKeyHelper` depend on the directory), must exit cleanly and positively report a subscription login. That means `loggedIn: true`, `apiProvider: "firstParty"`, no `apiKeySource`, and either `authMethod: "claude.ai"` with a `subscriptionType` or `authMethod: "oauth_token"` (a `claude setup-token` subscription token). An API key, a third-party provider, an unknown method, missing output, or any non-zero exit, timeout or signal of the status command (even after positive-looking output) refuses the turn (`claude_not_logged_in`, `claude_login_not_subscription`, `claude_auth_status_unavailable`) before the CLI starts it. Orkestr never reads the profile's credential files. Threads not created by a Setup are unchanged. Verified with fake providers only; not yet on real accounts (P0-01).

## Not claimed

No general one-click install, no WhatsApp connection, no "€0 extra" cost, no
unlimited or 24/7 operation, no medical or fitness outcome.
