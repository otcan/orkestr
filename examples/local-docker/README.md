# Local Docker Example

Run from the repository root:

```bash
docker compose up --build
```

Then open:

```text
http://127.0.0.1:19812
```

Runtime state is stored in the `orkestr-data` Docker volume. The mounted overlay uses fake example data only.

The image builds the Angular app during the Docker build and serves the compiled
UI from Fastify. No frontend build step runs at container startup.
