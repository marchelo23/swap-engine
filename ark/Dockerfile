FROM docker.io/library/rust:1.97.1-slim-bookworm

ARG CARGO_BUILD_JOBS=4

RUN apt-get update && apt-get install -y --no-install-recommends \
      bash \
      build-essential \
      ca-certificates \
      curl \
      git \
      jq \
      libsqlite3-dev \
      libssl-dev \
      pkg-config \
      protobuf-compiler \
    && rm -rf /var/lib/apt/lists/* \
    && rustup component add rustfmt clippy

RUN groupadd --gid 1000 arklab \
    && useradd --uid 1000 --gid 1000 --create-home --shell /bin/bash arklab \
    && mkdir -p /workspace/ark /workspace/data/ark \
    && chmod 0700 /workspace/data /workspace/data/ark \
    && chown -R 1000:1000 /workspace /home/arklab

WORKDIR /workspace/ark

COPY --chown=1000:1000 Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY --chown=1000:1000 ark-lab ./ark-lab
COPY --chown=1000:1000 scripts ./scripts

RUN chmod 0755 /workspace/ark/scripts/sdk-entrypoint.sh

USER arklab

ENV HOME=/home/arklab \
    CARGO_HOME=/home/arklab/.cargo \
    CARGO_INCREMENTAL=0 \
    CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS} \
    ARK_LAB_NETWORK_MODE=docker

# Verify pinned official arkade-os/rust-sdk revision and pre-build all locked
# binaries and tests so runtime execution inside the internal network is offline.
RUN grep -Fq 'https://github.com/arkade-os/rust-sdk?rev=352ca21bcaa01d3ddb535b0ebfb20cd9b028c357' /workspace/ark/Cargo.lock \
    && cargo --version \
    && rustc --version \
    && cargo fmt --all -- --check \
    && cargo build --locked \
    && cargo test --locked --no-run \
    && cargo clippy --locked --offline --all-targets --all-features -- -D warnings

ENTRYPOINT ["/workspace/ark/scripts/sdk-entrypoint.sh"]
CMD ["idle"]
