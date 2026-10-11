# Backlog reconciliation (2026-10-11)

This reconciles the strategy package backlog (`IMPLEMENTATION_BACKLOG.md`,
`SETUP_CONTRACT.md`) with code on branch `orkestr/setups-phase-a` (head
`47c9fd66`, on main `92a0ed80`). Status values:

- **VERIFIED**: code plus a passing test on this branch.
- **PARTIAL**: some of it verified.
- **OPEN**: not built.
- **BLOCKED**: needs a decision or an external check.

## P0: validate the promise

| ID | Status | Evidence / gap |
|---|---|---|
| P0-01 subscription runtime matrix | OPEN | Login paths exist (Codex device auth; Claude browser and code). Limits are detected (`/api/quota/providers`). There is no unattended timer run on either provider for a Setup thread, and no restart or expiry run. |
| P0-02 WhatsApp route | BLOCKED | Orkestr uses the unofficial `whatsapp-web.js` 1.34.7. The WhatsApp EEA terms prohibit unauthorized automated access. The official Cloud API needs a Meta business account, templates and per-message fees. No permitted consumer route has been identified, so web chat is the beta channel. |
| P0-03 supported environment | OPEN | Install still needs `install.sh`, Docker or npm plus `orkestr connect approve`. Node 22+. No OS or hardware matrix. |
| P0-04 manifest RFC | PARTIAL | `orkestr.setup/v1` exists with tests (`docs/setups/manifest-v1.md`). It is missing the package's fields: platforms, `forbidSilentPaygFallback`, preferred and fallback channels, quiet hours, `defaultEnabled`/consent, healthchecks, and pause/resume/upgrade/export. A compatibility fixture is also missing. |
| P0-05 trust and cost wording | PARTIAL | Wording is drafted in `whatsapp-and-provider-feasibility.md`. Whether unattended use of a consumer plan is allowed is still not confirmed from a primary source. |

## P1: ship one real Setup

| ID | Status | Evidence / gap |
|---|---|---|
| P1-01 registry and install/uninstall | PARTIAL | VERIFIED: idempotent install, exact rollback, owned-only uninstall, no duplicate timers created by repeated install (`test/setup-installer.test.js`, `test/setup-command-api.test.js`). OPEN: `configure`, pause/resume, upgrade, export. **Gap found:** the Codex check accepts an API-key login (`authMode: api_key`), so pay-as-you-go could be used silently. It must require a ChatGPT login. |
| P1-02 wizard | OPEN | Spec only (`phase-b-wizard-and-fitness-store.md`). |
| P1-03 fitness event store | OPEN | Spec says JSONL; the package asks for SQLite. Decide before building. |
| P1-04 workout parser | OPEN | |
| P1-05 progress view | OPEN | |
| P1-06 scheduled review | PARTIAL | Timezone is supported. **Conflict:** Phase A creates check-ins enabled. The package requires discretionary outbound schedules off until opt-in. No pause/stop controls per Setup yet. **Verified bugs:** overlapping ticks deliver twice, and there is no retry backoff (todo tests in `test/timer-loop-reliability.test.js`). |
| P1-07 provider errors | PARTIAL | Limit detection exists. There is no Setup-level surfacing and no suspension after repeated auth errors. Claude child processes get an allowlisted env (`claude-code-environment.js`), so a host `ANTHROPIC_API_KEY` is not passed through (VERIFIED in code). |
| P1-08 end-to-end | OPEN | |
| P1-09 alpha, P1-10 beta | OPEN | |

## Contract items with a verified blocker

- **Codex threads do not receive the standing mission per turn;** only the Claude runtime applies it. Setup instructions must reach Codex threads another way.
- **Single-writer ledger lock;** the CLI goes through the server API. Acceptable for v1.
- **Installs are admin only.**

## Proposed next build order (needs approval)

1. Fix the gaps in my own Phase A code:
   - require a ChatGPT login for Codex (no API key);
   - create check-ins disabled until opt-in;
   - add pause/resume and `configure`.
2. Timer reliability: an in-flight guard and failure backoff. This touches the shared scheduler, so it needs a normal release review.
3. Deliver Setup instructions to Codex threads.
4. P0-01 matrix: one real unattended timer run per provider on throwaway accounts.
5. Then P1-03 to P1-06 (store, parser, progress, opt-in review), then the wizard (P1-02).
