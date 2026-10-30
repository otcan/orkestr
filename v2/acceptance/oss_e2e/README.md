# OSS release-candidate end-to-end acceptance

`oss_e2e.mjs` runs the new-user Docker path against a clean Linux target over SSH, the same steps a person does
from the [V2 quickstart](../../README.md):

| Step | What is checked |
|---|---|
| 1-install | Clone the candidate ref, write `.env`, `docker compose up -d --build` (or a `docker save` archive with `--prebuilt-image`). Health must report the exact checked-out commit. |
| 2-owner-account | **First-time setup** in the real web UI with the bootstrap token, then sign-in. |
| 3-provider-login | Codex must be signed in with ChatGPT. When it is not, the official device login starts on the target and the harness prints the link and code for a person to complete, then waits (`--login-timeout-min`, default 15). `--with-claude` requires an existing Claude login. |
| 4-connect | `orkestr-beta configure` with the owner account, restart, and configured beta discovery. |
| 5a-chat-quick-and-deep | "In one sentence: what can you help me with?" Fast and Deep completion times are recorded separately. |
| 5b-followup-german | "Say that again in German." needs a German answer in the same conversation. |
| 6-job-tracker (`--with-tracker`, optional) | New "Job search" conversation, **Set up job tracker** → **Find mail folders** (records the message), the job prompt, and whether a row appeared. This step is recorded but does not fail the run. |
| 7a-stop-mid-generation | A 2000-word story. **Stop** while Deep runs. Deep must reach `cancelled` and the UI must show **Stopped**. |
| 7b-shutdown | `docker compose down`, with no containers left. |

The run writes `report.json` (pass/fail, milliseconds, and reply excerpts per step) and screenshots to `--out`.
The exit code is 0 only when every required step passes.

## Requirements
- Operator machine: Node 22, `ssh`, and `puppeteer` (the repository's `npm ci --ignore-scripts` provides it), or
  `puppeteer-core` with `CHROME_PATH` pointing at a Chrome or Chromium binary.
- Target: a clean Linux x86_64 machine with Docker Engine, Compose v2, git and curl, plus an SSH login for a user in
  the `docker` group. Port 19822 must be free on the target. The browser reaches the target through an SSH SOCKS
  tunnel, so the UI runs on its exact configured origin `http://127.0.0.1:19822` and nothing is published to a
  network.

## Run
```sh
node v2/acceptance/oss_e2e/oss_e2e.mjs --target user@test-vm --ssh-key ~/.ssh/test-vm \
  --ref v2.0.0-beta.5 --with-tracker --out ./oss-e2e-beta5
```
- `--ref` takes a tag, a branch or a **full** commit SHA.
- `--reset-state` deletes only the `state` volume first. That gives a new owner account and conversations while
  keeping the provider logins in the `credentials` volume, so a target that holds a Codex login can test each
  candidate unattended.
- `--wipe` logs Codex and Claude out inside the container and deletes both volumes at the end.
- `--keep-running` skips the shutdown step.

## Secrets
Nothing secret is stored in this directory or in the report. The owner password is random for each run and stays in
memory. The bootstrap token is read over SSH into memory and typed into the form. Provider logins exist only in the
target's `credentials` volume, created by the official CLIs. Do not copy a host's `~/.codex/auth.json` or Claude
credentials to a target: refresh-token rotation there can sign the original out. OpenAI API-key logins are refused
by the broker, which requires a ChatGPT account.
