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
- Prefer local-first defaults. Do not require a cloud account except user-provided connector credentials.
- Do not add enterprise/team/plugin abstractions until the V1 onboarding loop is reliable.
- Keep the install path boring: clone/install/start, open setup wizard, connect accounts, create timer.
- Keep files small and purpose-specific. If a file is approaching 500 lines, split new behavior into a separate module, component, helper, controller, or template when it can be managed cleanly.
- Do not keep extending already-large files with unrelated UI, backend, routing, or integration logic. Exceed 500 lines only when splitting would create artificial fragmentation or a risky refactor.
