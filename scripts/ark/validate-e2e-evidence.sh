#!/usr/bin/env bash
# Delegates to the single canonical strict fail-closed evidence validator packaged
# into deploy/ark/ci-tools/Dockerfile at /usr/local/libexec/ark-validate-e2e-evidence.sh.
set -euo pipefail
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
exec bash "$script_dir/../../deploy/ark/ci-tools/validate-e2e-evidence.sh" "$@"
