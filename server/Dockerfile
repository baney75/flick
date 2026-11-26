# syntax=docker/dockerfile:1
# flick-server with the Flick web app built in. Build from the repo root:
#   docker build -f server/Dockerfile -t flick-server .

# The web app is the same on every architecture, so build it natively once.
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS web
WORKDIR /src
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY index.html vite.config.ts tsconfig.json ./
COPY public public
COPY src src
RUN npx vite build

FROM rust:1-bookworm AS server
WORKDIR /src
COPY server server
# The embed-web feature reads ../dist next to server/.
COPY --from=web /src/dist dist
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/server/target \
    cargo build --release --locked --features embed-web --manifest-path server/Cargo.toml \
    && cp server/target/release/flick-server /flick-server

FROM debian:bookworm-slim
# ca-certificates tracks Debian's security updates, so it is not pinned.
# hadolint ignore=DL3008
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1000 flick \
    && useradd --uid 1000 --gid 1000 --no-create-home --shell /usr/sbin/nologin flick \
    && mkdir -p /config /media && chown flick:flick /config
COPY --from=server /flick-server /usr/local/bin/flick-server
USER 1000:1000
ENV FLICK_SERVER_CONFIG=/config
VOLUME ["/config"]
EXPOSE 8740
# The server shuts down cleanly on Ctrl-C (SIGINT).
STOPSIGNAL SIGINT
ENTRYPOINT ["flick-server"]
# A container must listen on all interfaces to be reachable through its published port.
CMD ["--lan", "--media", "/media"]
