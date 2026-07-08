# AGENTS.md

This repository is the open-source Orkestr product scaffold. Treat every file,
comment, example, test fixture, commit, branch, and issue reference here as
public-facing by default.

Rules:

- Orkestr OSS must never contain confidential information. If something cannot
  be published to the public internet, it does not belong in this repo.
- Keep personal deployment code, private hostnames, WhatsApp Web session state, Gmail tokens, LinkedIn profiles, and machine-specific user/home assumptions out of this repo.
- Keep real overlays in a private repo. Public examples must use fake IDs, fake hosts, and generic prompts only.
- Generic code goes in this repo; personal bindings, timers, prompts, browser profiles, deployment files, and secrets belong outside this repo and are loaded through `ORKESTR_OVERLAY_DIR`.
- V1 scope is only setup UI, OpenAI/Codex, Gmail, LinkedIn virtual browser, WhatsApp, virtual browsers, and timers.
- Prefer self-hosted defaults on infrastructure the user controls. Do not require
  a cloud account except user-provided connector credentials.
- Do not add enterprise/team/plugin abstractions until the V1 onboarding loop is reliable.
- Keep the install path boring: clone/install/start, open setup wizard, connect
  the first capability, create a thread or timer.
- Release, tag, merge-to-main, and deploy work must follow
  `docs/release-train.md`. Worker and parent threads may commit and push their
  own branches, but deployments must go through the release train.
- A release train must not leave corresponding parent, worker, or release
  branches silently stale. After `main` moves, immediately fast-forward and push
  every clean corresponding worker/release branch whose tip is an ancestor of
  the released commit, refresh Orkestr git state, and verify the WebUI reports
  no parent/remote drift. If a corresponding branch has unique unmerged commits
  or local edits, stop and report the exact blocker before calling the train
  complete.
- Real WhatsApp E2E is an optional diagnostic, not a release/deploy gate. Do not
  block releases on WA2WA availability unless a user explicitly asks for that
  check in the current release.
- Keep files small and purpose-specific. If a file is approaching 500 lines, split new behavior into a separate module, component, helper, controller, or template when it can be managed cleanly.
- Do not keep extending already-large files with unrelated UI, backend, routing, or integration logic. Exceed 500 lines only when splitting would create artificial fragmentation or a risky refactor.

## Runtime Orientation for Agents

Orkestr-managed Codex sessions should discover live context dynamically instead
of relying on static thread or workspace text in this file.

- Run `orkestr whereiam --json` from the current shell to identify the active
  Orkestr thread, runtime workspace, repository path, branch, tmux session, and
  safe capability hints.
- API callers can use `GET /api/whereiam?cwd=<absolute-current-directory>`.
  A plain HTTP request cannot reveal the caller's working directory, so pass
  `cwd` explicitly. API callers with a stable session id should bind with
  `apiSessionId=<stable-id>&bind=1`, then post visible assistant messages with
  `orkestr api-session message "<text>" --api-session-id <stable-id>` so
  WhatsApp delivery failures surface immediately.
- Use `orkestr list`, `orkestr send <thread> "<message>"`, `orkestr wake
  <thread>`, and `orkestr sleep <thread>` for thread control.
- Use `orkestr timers list`, `orkestr timers run <timer-id>`, and `orkestr
  doctor timers` for timers.
- Treat the Codex CLI/session as the default agent runtime. A normal Orkestr
  coding thread should use the user's Codex CLI login and Codex limits. Direct
  OpenAI API calls are optional connector or skill paths only; do not assume an
  OpenAI API key is required for a Codex thread.
- Use Orkestr APIs for browser and desktop state: `GET /api/browser-sessions`,
  `GET /api/desktops/leases`, `POST /api/desktops/:slug/acquire`, heartbeat,
  and release.
- Use connector status APIs for Gmail and WhatsApp. Do not read Gmail tokens,
  WhatsApp session state, browser profiles, or files under `ORKESTR_HOME/secrets`
  directly.
- When creating WhatsApp-backed threads or groups, default participants must
  come only from explicit owner/self-account configuration. Do not infer or reuse
  participants from prior chats, projects, or examples. If additional people or
  accounts are ambiguous, ask the user before creating the group or promoting
  anyone.
- When a user asks for an isolated "slice", treat that as a tenant-slice and
  tenant-VM provisioning request, not as a normal Orkestr thread. Use the
  tenant-slices and tenant-vms registries/provisioning flow, keep it out of the
  parent Orkestr thread list, and verify the tenant VM, LLM sanitizer runtime
  env, Docker bootstrap, and explicit WhatsApp forwarding route before calling
  the slice ready.
- When provisioning repeatable LinkedIn account bundles for friends, clients, or
  collaborators, do not hand-create the WhatsApp chat, thread, browser desktop,
  CRM/oXRM instance, repo, and timer as unrelated one-off steps. Use a private
  operator workflow/skill such as `linkedin-friend-provisioning` when available.
  Keep real phone numbers, browser profiles, private prompts, deployment files,
  timer overlays, CRM/oXRM instance env files, and backup credentials outside
  this OSS repo.
- For WhatsApp-backed friend/client bundles, preserve explicit participant
  intent: the external account owner must be recorded separately from owner/self
  admin numbers, the reply account must be verified after binding, and disabled
  chats must surface a visible warning instead of silently ignoring messages.
- For WhatsApp-routed chats, use `NO_REPLY` as the exact whole assistant
  message when the inbound message clearly needs no visible answer or action.
  Typical cases include side conversation, a friend/third-party mention,
  context-only chatter, duplicates, accidental fragments, or messages that are
  irrelevant to the active Orkestr task. Do not reply with "OK", "Noted",
  "Done", or similar acknowledgements in those cases. Do not use `NO_REPLY` for
  questions, commands, error reports, safety/privacy issues, or ambiguous
  messages where silence would look like a broken assistant.
- When a browser desktop is needed, acquire the desktop lease first and release
  it when finished. Do not assume a desktop is free because a profile directory
  exists.
- Do not launch unmanaged Chrome, create ad hoc browser profiles, or bypass the
  desktop lease APIs for web work. If a connector needs browser state, use the
  managed Orkestr browser or desktop surface assigned to that connector.
