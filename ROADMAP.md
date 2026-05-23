# Roadmap

Orkestr is moving toward one reliable public loop:

Install locally, open setup, pair WhatsApp, prepare a virtual desktop, create a Codex-backed coding thread, send work from WhatsApp or the web UI, and inspect the logs.

## Now

- Clean public launch docs.
- `/setup` as the first-run setup route.
- Built-in local WhatsApp bridge with two account slots.
- Virtual Desktop Generation as a first-class onboarding goal.
- Thread-first runtime APIs for local Codex sessions.
- Deterministic coding-agent demo and public sample logs.

## Next

- Harden secure access onboarding with smoother Caddy/Tailscale validation, clearer pairing diagnostics, and safer remote-access defaults.
- Add optional short demo clips from disposable fake-data runs.
- Clearer WhatsApp chat binding flow.
- Better virtual desktop open/status controls.
- CLI polish: `orkestr setup`, `orkestr logs`, completions, stable JSON for every command.

## Later

- Richer timer doctor and schedule history.
- More browser profiles.
- Safer approval workflows for outbound actions.
- Packaged release builds.
- Public plugin/extension points after V1 onboarding is stable.

## Out Of Scope For V1

- Hosted multi-user SaaS.
- Enterprise teams and RBAC.
- Marketplace/plugin abstractions.
- Public cloud dependency as a requirement.
- Shipping private deployment code in OSS.
