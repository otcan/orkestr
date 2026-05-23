# Local Docker Example

Run from the repository root:

```bash
cp .env.docker.example .env
docker compose up -d
```

Then open:

```text
http://127.0.0.1:19812/setup
```

Runtime state is stored in the `orkestr-data` Docker volume. Settings are read
from `.env`; the mounted overlay uses fake example data only unless you point
`ORKESTR_OVERLAY_HOST_DIR` at a private overlay outside the repo.

The container image includes Codex, tmux, git, ripgrep, and Chromium. Open
`/setup`, add Codex, and use the Codex sign-in button to complete device
authorization in the browser. Codex auth is stored under `/data/codex` inside
the Docker volume.

The default Compose file uses the published `ghcr.io/otcan/orkestr:latest`
image. To build the image from this checkout instead:

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up --build
```

No frontend build step runs at container startup.
