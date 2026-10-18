# Supply an inspected, already-local Python/glibc base by immutable image digest.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
USER 0
RUN mkdir -p /state /opt/v2 && chown 10001:10001 /state && chmod 0700 /state
COPY --chown=10001:10001 server /opt/v2/server
COPY --chown=10001:10001 ui /opt/v2/ui
COPY --chown=10001:10001 entrypoint.py dormant.py artifact-manifest.json /opt/v2/
USER 10001:10001
WORKDIR /state
ENTRYPOINT ["python3", "-B", "/opt/v2/entrypoint.py"]
