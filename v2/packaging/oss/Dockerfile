# Source build: the only application input is an anonymous public Git commit.
# No local source, provider login, build cache or account state is copied in.
FROM node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS browser-tools
FROM rust:1.99.1-bookworm@sha256:48b7f435b8fc6378ce43b44f15e3a47fd8919b2825f835c39bd4bd3da50af5b8 AS source-check
ARG SOURCE_COMMIT
ARG BUILD_JOBS=2
RUN { test ${#SOURCE_COMMIT} -eq 40 \
      && test -z "$(printf %s "$SOURCE_COMMIT" | tr -d '0-9a-f')"; } \
    || { echo 'SOURCE_COMMIT must be the exact 40-character public commit; see v2/README.md (ORKESTR_SOURCE_COMMIT in v2/packaging/oss/.env).' >&2; exit 1; } \
    && case "$BUILD_JOBS" in \
         [1-9]|[1-5][0-9]|6[0-4]) touch /source-validated ;; \
         *) echo 'BUILD_JOBS must be a whole number from 1 to 64.' >&2; exit 1 ;; \
       esac

FROM source-check AS source
RUN git init /src && git -C /src fetch https://github.com/otcan/orkestr.git "$SOURCE_COMMIT" \
    && git -C /src checkout --detach FETCH_HEAD \
    && test "$(git -C /src rev-parse HEAD)" = "$SOURCE_COMMIT"

# The constant marker orders setup after validation without making its cache
# depend on a commit. Fetch and tooling can run in parallel after this gate.
FROM rust:1.99.1-bookworm@sha256:48b7f435b8fc6378ce43b44f15e3a47fd8919b2825f835c39bd4bd3da50af5b8 AS tooling
COPY --from=source-check /source-validated /tmp/source-validated
COPY --from=browser-tools /usr/local/bin/node /usr/local/bin/node
COPY --from=browser-tools /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm
ENV PYTHONDONTWRITEBYTECODE=1 CARGO_TARGET_DIR=/build/target
RUN apt-get update && apt-get install -y --no-install-recommends python3 \
    && rm -rf /var/lib/apt/lists/*
ARG BUILD_JOBS=2
ENV CARGO_BUILD_JOBS=$BUILD_JOBS
RUN rustup target add wasm32-unknown-unknown \
    && cargo install --locked wasm-bindgen-cli --version 0.2.129

# Only manifests, lockfiles and empty Cargo target placeholders cross this
# boundary. Ordinary source edits retain downloaded, locked dependencies.
FROM tooling AS dependency-inputs
# Select the image's pinned Cargo without asking rustup to install the source
# checkout's developer-only components during metadata or dependency fetch.
ENV RUSTUP_TOOLCHAIN=1.99.1
COPY --from=source /src /src
RUN python3 -I -S -B /src/v2/packaging/oss/dependency_inputs.py /src /dependency-inputs

FROM tooling AS dependencies
ENV RUSTUP_TOOLCHAIN=1.99.1
COPY --from=dependency-inputs /dependency-inputs /dependencies
RUN cd /dependencies/v2 && cargo fetch --locked \
    && npm --prefix /dependencies ci --ignore-scripts --no-audit --no-fund

FROM dependencies AS build
COPY --from=source /src /src
RUN cp -a /dependencies/node_modules /src/node_modules \
    && python3 -I -S -B /src/v2/packaging/oss/build.py \
    && rm -rf /src/node_modules

# Export the unchanged #265 tarball, paired receipt and checksums without publishing.
FROM scratch AS bundle
COPY --from=build /artifacts/distribution/ /

FROM python:3.12-slim@sha256:cb33f7f771ecec2ef1225cf39b159591a040391bd73e4c01f00fdfc4c47611d2 AS runtime
ENV PYTHONDONTWRITEBYTECODE=1
COPY --from=source-check /source-validated /tmp/source-validated
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 git bubblewrap util-linux nginx-light ca-certificates binutils \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 orkestr && useradd --uid 10001 --gid 10001 --no-create-home orkestr \
    && mkdir /state /credentials && chmod 0755 /state /credentials
COPY --from=build /src /opt/orkestr/source
COPY --from=build /artifacts/server /opt/orkestr/server
COPY --from=build /artifacts/ui /opt/orkestr/ui
COPY --from=build /artifacts/paired-artifacts.json /opt/orkestr/paired-artifacts.json
COPY --from=build /artifacts/providers /opt/orkestr/providers
RUN ln -s /opt/orkestr/providers/codex /usr/local/bin/codex \
    && ln -s /opt/orkestr/providers/claude /usr/local/bin/claude \
    && install -m 0555 /opt/orkestr/source/v2/packaging/oss/orkestr-beta /usr/local/bin/orkestr-beta
EXPOSE 19823
# Same probe as compose.yaml, so a plain `docker run` reports health too.
HEALTHCHECK --interval=5s --timeout=3s --retries=30 \
    CMD ["/usr/bin/python3", "-I", "-S", "-B", "/opt/orkestr/source/v2/packaging/oss/runtime.py", "health"]
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/bin/python3", "-I", "-S", "-B", "/opt/orkestr/source/v2/packaging/oss/runtime.py"]
