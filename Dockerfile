# Hexactra Agent OCI Image
# Multi-stage build for minimal production image

# Stage 1: Build
FROM rust:1.82-slim AS builder

WORKDIR /build

# Install build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy Cargo manifests
COPY Cargo.toml Cargo.lock ./
COPY crates/ ./crates/

# Build release binaries
RUN cargo build --release --bin hexactra \
    --bin hexactra-agent \
    --bin hexactra-native-host \
    --bin hexactra-mcp

# Stage 2: Production
FROM debian:bookworm-slim AS production

# Install runtime dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    libssl3 \
    libsqlite3-0 \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user for running the agent
RUN groupadd -r hexactra-agent && useradd -r -g hexactra-agent hexactra-agent

# Create necessary directories
RUN mkdir -p /usr/local/bin \
    /etc/hexactra \
    /var/lib/hexactra \
    /run/hexactra \
    /var/log/hexactra \
    /tmp/hexactra

# Set ownership
RUN chown -R hexactra-agent:hexactra-agent /var/lib/hexactra \
    && chown -R hexactra-agent:hexactra-agent /run/hexactra \
    && chown -R hexactra-agent:hexactra-agent /var/log/hexactra

# Copy binaries from builder stage
COPY --from=builder /build/target/release/hexactra /usr/local/bin/
COPY --from=builder /build/target/release/hexactra-agent /usr/local/bin/
COPY --from=builder /build/target/release/hexactra-native-host /usr/local/bin/
COPY --from=builder /build/target/release/hexactra-mcp /usr/local/bin/

# Make binaries executable
RUN chmod +x /usr/local/bin/hexactra \
    && chmod +x /usr/local/bin/hexactra-agent \
    && chmod +x /usr/local/bin/hexactra-native-host \
    && chmod +x /usr/local/bin/hexactra-mcp

# Copy configuration example
COPY deploy/systemd/hexactra-agent.service /etc/systemd/system/
COPY config/ /etc/hexactra/

# Expose ports (if needed for control plane)
EXPOSE 8080

# Set working directory
WORKDIR /var/lib/hexactra

# Security hardening
USER hexactra-agent
RUN chmod 700 /var/lib/hexactra \
    && chmod 700 /run/hexactra \
    && chmod 755 /tmp/hexactra

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

# Default command
CMD ["hexactra-agent", "daemon"]
