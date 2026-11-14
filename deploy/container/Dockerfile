# Hexactra container images (#197).
#
#   docker build -f deploy/container/Dockerfile --target control -t hexactra-control .
#   docker build -f deploy/container/Dockerfile --target host    -t hexactra-host .
#
# control: hexactra-control (API), plus the hexactra CLI and hexactra-mcp.
# host:    Chromium on Xvfb with the Hexactra extension, the agent in launch
#          mode, the native messaging host and a password-protected noVNC viewer.

# ---------------------------------------------------------------- build: Rust
FROM rust:1-bookworm AS rust-build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY tests/Cargo.toml tests/platform_compatibility.rs ./tests/
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked \
      -p hexactra-control -p hexactra-cli -p hexactra-mcp \
      -p hexactra-agent -p hexactra-native-host \
 && mkdir -p /out \
 && for b in hexactra hexactra-control hexactra-mcp hexactra-agent hexactra-native-host; do \
      cp "target/release/$b" /out/; \
    done

# ------------------------------------------------------- build: the extension
FROM node:22-bookworm-slim AS ext-build
WORKDIR /src
RUN npm install -g pnpm@9.0.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile \
 && pnpm --filter "@hexactra/chrome-extension..." build \
 && test -f apps/chrome-extension/dist/manifest.json

# ----------------------------------------------------------------- base image
FROM debian:bookworm-slim AS runtime-base
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl tini procps \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 1000 --shell /usr/sbin/nologin hexactra \
 && mkdir -p /data && chown hexactra:hexactra /data
ENV XDG_CONFIG_HOME=/data/config

# ------------------------------------------------------------ target: control
FROM runtime-base AS control
COPY --from=rust-build /out/hexactra-control /out/hexactra /out/hexactra-mcp /usr/local/bin/
USER hexactra
# Listens on all interfaces inside the container; compose publishes it on
# 127.0.0.1 only. The API token comes from HEXACTRA_API_TOKEN.
ENV HEXACTRA_BIND=0.0.0.0:8787 \
    HEXACTRA_ALLOW_REMOTE_BIND=true
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s \
  CMD curl -fsS http://127.0.0.1:8787/v1/health || exit 1
ENTRYPOINT ["/usr/bin/tini", "--", "hexactra-control", "serve"]

# --------------------------------------------------------------- target: host
FROM runtime-base AS host
# chrome-sandbox is the only binary left setuid: the SYS_ADMIN capability the
# browser sandbox needs (see compose.yml) is then not reachable through su,
# mount and friends.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium chromium-sandbox \
      xvfb openbox x11vnc novnc websockify \
      fonts-liberation fonts-dejavu-core fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix \
 && find / -xdev -perm -4000 -type f ! -path /usr/lib/chromium/chrome-sandbox -exec chmod u-s {} + \
 && test -u /usr/lib/chromium/chrome-sandbox
COPY --from=rust-build /out/hexactra-agent /out/hexactra-native-host /usr/local/bin/
COPY --from=ext-build /src/apps/chrome-extension/dist /opt/hexactra/extension
COPY deploy/container/host-entrypoint.sh /usr/local/bin/hexactra-host
RUN chmod 0755 /usr/local/bin/hexactra-host
USER hexactra
ENV DISPLAY=:99 \
    XDG_RUNTIME_DIR=/tmp/hexactra-run \
    HEXACTRA_BROWSER=/usr/bin/chromium \
    HEXACTRA_PROFILE_DIR=/data/profile \
    HEXACTRA_EXTENSION_DIR=/opt/hexactra/extension \
    HEXACTRA_NATIVE_HOST=/usr/local/bin/hexactra-native-host
VOLUME /data
EXPOSE 6080
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s \
  CMD pgrep -x Xvfb >/dev/null && pgrep -x hexactra-agent >/dev/null || exit 1
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/hexactra-host"]
