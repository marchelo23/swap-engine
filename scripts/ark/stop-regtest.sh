#!/usr/bin/env bash
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
setup_engine
setup_state
assert_resources
[[ -e "$env_file" ]] || exit 0
require_env
# Use the exact validated names instead of stopping every container with a
# potentially colliding project label. Uncreated containers are skipped.
existing=$(docker ps --filter "label=$owner_label=$root" --format '{{.Names}}')
for ((i=${#managed_services[@]}-1; i>=0; i--)); do
  name="ark_lab_${managed_services[i]}"
  if grep -Fxq "$name" <<<"$existing"; then docker stop -t 30 "$name"; fi
done
