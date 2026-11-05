# Local Docker account setup (unreleased)

This change is for the next beta. The published beta.6 still requires the
setup token from the container log.

## Prebuilt test images from CI

The **V2 public-source Linux image** run linked from the pull request retains
`v2-test-image-amd64-RUN_ID` and `v2-test-image-arm64-RUN_ID` artifacts for seven
days. Choose amd64 for Intel/AMD Linux or arm64 for ARM Linux/Apple Silicon.
These contain Docker images, exported after that architecture's fresh-install
checks pass. Wait for all pull-request checks, including the separate browser
workflow, to be green before owner acceptance.

Download and extract the artifact using GitHub's run page (sign-in required).
Check its accompanying SHA256 file, then import the image:

```sh
# Use arm64 instead of amd64 for Apple Silicon or ARM Linux.
sha256sum -c orkestr-oss-test-amd64.tar.gz.sha256
docker load -i orkestr-oss-test-amd64.tar.gz
```

On macOS, use `shasum -a 256 -c` in place of `sha256sum -c`.
Docker prints the imported `orkestr-oss-test:COMMIT` tag. Use that exact tag
with fresh test volumes:

```sh
docker run -d --name orkestr-simple-test --cap-add SYS_PTRACE \
  -e ORKESTR_OSS_LOCAL_SETUP=1 -p 127.0.0.1:19822:19823 \
  -v orkestr-simple-state:/state -v orkestr-simple-credentials:/credentials \
  orkestr-oss-test:COMMIT
```

The image loads locally without a source build. These are candidate CI
artifacts; a GHCR release remains a separate owner-approved operation.

## Source builds

For a source build of a checkout containing this change, the loopback-only
Compose service enables local account setup automatically. Build and start
that exact public commit:

```sh
printf 'ORKESTR_SOURCE_COMMIT=%s\n' "$(git rev-parse HEAD)" > v2/packaging/oss/.env
docker compose -f v2/packaging/oss/compose.yaml up -d --build
```

Open **http://127.0.0.1:19822**. The first screen is **Create your account**:
choose a username and password of at least 12 characters, then continue.
There is no setup token to copy and no separate sign-in step. Next, choose
**Connect models**, sign in to Codex with ChatGPT, and activate the models.

After account creation or a restart, the page asks you to sign in. It cannot
create a replacement owner or change an existing owner's password.

For a direct `docker run` of an image containing this change, enable
`-e ORKESTR_OSS_LOCAL_SETUP=1` alongside `-p 127.0.0.1:19822:19823`.
This option deliberately trusts the first person who can reach the local
port. Only enable it with the loopback publishing shown here (an SSH tunnel
to that loopback port is also supported). Container networking hides the
original peer, so a request's Host header alone cannot prove it is local.

Without this option, the ordinary bootstrap-token setup remains required.
Do not enable it on a public or shared endpoint. The local account endpoint
requires the exact loopback Host, same-origin browser writes and a custom
request header; it grants no CORS permission. The bootstrap credential stays
inside the container and is never returned to the browser or printed in the
local-mode setup banner. Provider sign-in still requires the owner's session
and CSRF token. Activation removes the setup service and its routes entirely.

CI tests both setup modes on native amd64 and arm64. The local mode checks
first-owner creation without a browser-supplied token, rejection of foreign
origins, duplicate-owner protection, and ordinary sign-in after restart.
These are synthetic tests; real-account chat acceptance remains a separate
release gate.
