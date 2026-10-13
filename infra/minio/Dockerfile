FROM debian:bookworm-slim AS runtime-base
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
FROM runtime-base AS build
ARG TARGETARCH
RUN case "$TARGETARCH" in \
      amd64) checksum=ecbadb99091a3f46e31f5f934b068b1864eafa7995211b39eaddf76996045fe5 ;; \
      arm64) checksum=94f3e30b8e374bc285e7dadc11e0865726b9bc6e85b841ccceaabc0214c6b7c8 ;; \
      *) echo 'Unsupported architecture' >&2; exit 1 ;; \
    esac; curl -fSL --retry 3 "https://go.dev/dl/go1.27.2.linux-${TARGETARCH}.tar.gz" -o /tmp/go.tar.gz \
    && echo "$checksum  /tmp/go.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/go.tar.gz -C /usr/local && rm /tmp/go.tar.gz
ENV PATH=/usr/local/go/bin:$PATH
ARG GITHUB_PROXY_PREFIX=""
ARG SOURCE_SHA256=be6d0bd3696c3a13a35f02d3a0280b64319c67918b4501c5c3d87f96d000085c
RUN prefix="${GITHUB_PROXY_PREFIX%/}"; if [ -n "$prefix" ]; then prefix="$prefix/"; fi; curl -fSL --retry 3 "${prefix}https://github.com/minio/minio/archive/refs/tags/RELEASE.2025-10-15T17-29-55Z.tar.gz" -o /tmp/minio.tar.gz \
    && echo "$SOURCE_SHA256  /tmp/minio.tar.gz" | sha256sum -c - \
    && mkdir /src && tar -xzf /tmp/minio.tar.gz -C /src --strip-components=1
WORKDIR /src
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w -X github.com/minio/minio/cmd.ReleaseTag=RELEASE.2025-10-15T17-29-55Z' -o /minio .
FROM runtime-base
RUN mkdir /data && chown 1000:1000 /data
COPY --from=build /minio /usr/local/bin/minio
COPY --from=build /src/LICENSE /usr/share/licenses/minio/LICENSE
COPY entrypoint.sh /usr/local/bin/minio-entrypoint
USER 1000:1000
EXPOSE 9000 9001
ENTRYPOINT ["/usr/local/bin/minio-entrypoint"]
CMD ["server", "/data", "--console-address", ":9001"]
