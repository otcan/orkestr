# Quickstart

## Start Orkestr

```bash
git clone https://github.com/otcan/orkestr.git
cd orkestr
npm ci
npm start
```

Open http://127.0.0.1:19812/. The app opens after you connect Codex (ChatGPT
subscription) or Claude Code in the first-run wizard; there is no simulated
mode. With Docker instead:

```bash
docker run --name orkestr -p 3000:3000 -v orkestr-data:/data ghcr.io/otcan/orkestr:latest
```

## Your first Agent Job

Agent Jobs run on a real, connected provider (Codex or Claude); the simulated
provider above is a demo and test fixture only. Once `codex login` or
`claude auth login` works on this host:

`init` writes `my-jobs/jobs/hello-job.yaml` for your provider. From the clone,
`npx orkestr` runs this checkout's CLI:

```bash
npx orkestr init my-jobs
npx orkestr run my-jobs
npx orkestr jobs list
npx orkestr jobs status <run-id>
```

Triggers (API, webhook, schedule, WhatsApp group messages), approvals and
recovery are described in [the runner doc](spec/agent-job-runner.md).

## Next steps

Connect a real provider (Codex or Claude Code) and create your first thread
from the setup wizard. See the [README](../README.md#quickstart).
