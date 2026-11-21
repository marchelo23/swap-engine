FROM docker.io/library/node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54

LABEL io.swap-engine.ark.lab="ci-tools"

RUN apt-get update && apt-get install -y --no-install-recommends \
      bash \
      git \
      jq \
    && rm -rf /var/lib/apt/lists/*

COPY --chown=root:root --chmod=0555 validate-e2e-evidence.sh /usr/local/libexec/ark-validate-e2e-evidence.sh

USER node
WORKDIR /tmp
