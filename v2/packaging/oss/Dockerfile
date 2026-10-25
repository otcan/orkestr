# Source build: the only application input is an anonymous public Git commit.
# No local source, provider login, build cache or account state is copied in.
FROM rust:1.99.1-bookworm@sha256:48b7f435b8fc6378ce43b44f15e3a47fd8919b2825f835c39bd4bd3da50af5b8 AS build
ARG SOURCE_COMMIT
ENV PYTHONDONTWRITEBYTECODE=1 CARGO_BUILD_JOBS=2 CARGO_TARGET_DIR=/build/target
RUN apt-get update && apt-get install -y --no-install-recommends python3 \
    && rm -rf /var/lib/apt/lists/*
RUN rustup target add wasm32-unknown-unknown \
    && cargo install --locked wasm-bindgen-cli --version 0.2.129
RUN test ${#SOURCE_COMMIT} -eq 40 \
    && test -z "$(printf %s "$SOURCE_COMMIT" | tr -d '0-9a-f')" \
    && git init /src && git -C /src fetch https://github.com/otcan/orkestr.git "$SOURCE_COMMIT" \
    && git -C /src checkout --detach FETCH_HEAD \
    && test "$(git -C /src rev-parse HEAD)" = "$SOURCE_COMMIT"
RUN python3 -I -S -B /src/v2/packaging/oss/build.py

# Export the unchanged #265 tarball, paired receipt and checksums without publishing.
FROM scratch AS bundle
COPY --from=build /artifacts/distribution/ /

FROM python:3.12-slim@sha256:cb33f7f771ecec2ef1225cf39b159591a040391bd73e4c01f00fdfc4c47611d2 AS runtime
ENV PYTHONDONTWRITEBYTECODE=1
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
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/bin/python3", "-I", "-S", "-B", "/opt/orkestr/source/v2/packaging/oss/runtime.py"]
