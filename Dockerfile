# syntax=docker/dockerfile:1
# Build on the builder's own platform and cross-compile for the target platform, so
# multi-arch images need no emulation. The bun version must match .bun-version (a test checks).
FROM --platform=$BUILDPLATFORM oven/bun:1.3.13 AS build
ARG TARGETARCH
WORKDIR /src
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN case "$TARGETARCH" in \
      amd64) target=linux-x64 ;; \
      arm64) target=linux-arm64 ;; \
      *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
 && bun build --compile --minify --target=bun-$target src/main.ts src/diff/worker.ts --outfile /out/pixeltwin \
 && mkdir -p /out/data

# Distroless: glibc and certificates, no shell, runs as uid 65532.
FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /out/pixeltwin /usr/local/bin/pixeltwin
COPY --from=build --chown=65532:65532 /out/data /data
ENV DATA_DIR=/data PORT=8080
VOLUME /data
EXPOSE 8080
USER nonroot
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD ["/usr/local/bin/pixeltwin", "healthcheck"]
ENTRYPOINT ["/usr/local/bin/pixeltwin"]
CMD ["serve"]
