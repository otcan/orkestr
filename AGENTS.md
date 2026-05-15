# AGENTS.md

This repository is the open-source Orkestr product scaffold.

Rules:

- Keep personal deployment code, private hostnames, WhatsApp Web session state, Gmail tokens, LinkedIn profiles, and root/openclaw machine assumptions out of this repo.
- Keep real overlays in a private repo. Public examples must use fake IDs, fake hosts, and generic prompts only.
- Generic code goes in this repo; personal bindings, timers, prompts, browser profiles, deployment files, and secrets belong outside this repo and are loaded through `ORKESTR_OVERLAY_DIR`.
- V1 scope is only setup UI, OpenAI/Codex, Gmail, LinkedIn virtual browser, WhatsApp, virtual browsers, and timers.
- Prefer local-first defaults. Do not require a cloud account except user-provided connector credentials.
- Do not add enterprise/team/plugin abstractions until the V1 onboarding loop is reliable.
- Keep the install path boring: clone/install/start, open setup wizard, connect accounts, create timer.
