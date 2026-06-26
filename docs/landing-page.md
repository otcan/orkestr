# Minimal Landing Page

Use this as the shared one-page launch structure for Orkestr and oXRM.

## Headline

Local-first software for running agents against real workflows.

## Subheadline

Orkestr gives agents a workstation. oXRM gives them relationship memory.

## Orkestr

Orkestr is a local-first workstation for persistent coding and operations
agents. It provides setup, browser and phone control, thread status, timers,
connector routing, history, and localhost-first deployment defaults around
Codex.

Quickstart:

```bash
git clone https://github.com/otcan/orkestr.git
cd orkestr
npm ci
npm run build
npm run demo:coding-agent
```

## oXRM

oXRM is an MCP-first relationship workspace for agent-assisted follow-up,
outreach, job search, partnerships, investors, and warm leads. It uses synthetic
demo data and integrates with other projects through MCP/API contracts.

Quickstart:

```bash
git clone https://github.com/otcan/orkestr-crm.git
cd orkestr-crm
./oxrm start
./oxrm ready
./oxrm demo
./oxrm test
./oxrm urls
```

## Visuals

- Orkestr: `docs/assets/orkestr-three-screen-demo.png`
- oXRM: `docs/assets/oxrm-dashboard.png`

## Security Note

Both projects default toward local-first operation. Do not expose raw service
ports directly to the public internet. Use protected remote access, keep
credentials local, and use synthetic data in public demos.

