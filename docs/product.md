# Product

## One-line pitch

Give your AI agent a browser, WhatsApp, Gmail, LinkedIn, and a schedule.

## First user journey

1. Install Orkestr.
2. Setup wizard opens.
3. Connect OpenAI/Codex.
4. Configure the WhatsApp bridge.
5. Configure Gmail OAuth.
6. Prepare Gmail and LinkedIn virtual browser profiles.
7. Open LinkedIn virtual browser and log in.
8. Create the first agent template.
9. Add a recurring timer.
10. Message the agent from WhatsApp.
11. Watch it work in the browser.

## Default starter

The first starter is a job-search assistant:

- watches Gmail and LinkedIn for recruiting messages
- summarizes important messages to WhatsApp
- drafts replies, but does not send them without approval
- runs from a daily timer by default

This is the sharp initial wedge. Avoid adding generic chat surfaces until this works end-to-end.

## V1 boundaries

In:

- local setup
- public monorepo structure
- private overlay loading
- persistent connector config
- connector checks
- virtual browser profiles
- WhatsApp connector surface
- agent starter records
- agent inbox records
- timers
- local activity events
- Docker local deployment

Out:

- enterprise teams
- plugin marketplace
- Slack/Discord
- Kubernetes
- multi-tenant hosting
- private host assumptions
