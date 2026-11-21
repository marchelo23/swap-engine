#!/usr/bin/env bash
# Reproducible host wrapper for Ark CI auxiliary checks:
#   1. Bootstrap funding Bash regression (scripts/ark/test-bootstrap-funding.sh)
#   2. Full-index + full-history Git secret hygiene scan (scripts/check-secrets.mjs)
#
# Both checks run inside a pinned, offline (--network none), read-only container
# with streamed stdin inputs (zero bind mounts, zero docker.sock, zero secrets in
# Docker build context, and no Node/npm/jq required on the host).
set -euo pipefail
umask 077

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
context_dir="$root/deploy/ark/ci-tools"
dockerfile="$context_dir/Dockerfile"
validator_file="$context_dir/validate-e2e-evidence.sh"
container_validator="/usr/local/libexec/ark-validate-e2e-evidence.sh"
image="swap-engine-ark-ci-tools:local"
pinned_base="docker.io/library/node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54"
approved_evidence_files=(
  boarding.json
  matrix.json
  offboard.json
  renewal.json
  restart.json
  transfer.json
)

fail() {
  printf 'Ark docker-ci-checks: %s\n' "$*" >&2
  exit 1
}

setup_engine() {
  local version endpoint
  command -v docker >/dev/null || fail "missing docker CLI"
  unset DOCKER_HOST DOCKER_CONTEXT CONTAINER_HOST CONTAINER_CONNECTION PODMAN_HOST
  version=$(docker --version 2>/dev/null) || fail "cannot query docker CLI version"
  if [[ "$version" != *podman* && "$version" != *Podman* ]]; then
    endpoint=$(docker context inspect --format '{{.Endpoints.docker.Host}}') ||
      fail "cannot inspect Docker context"
    [[ "$endpoint" == unix:///* ]] || fail "Docker context must use a local Unix socket"
  fi
  docker info --format '{{.ServerVersion}}' >/dev/null || fail "local container engine unavailable"
}

run_hardened() {
  local tmpfs_size=$1
  local container_script=$2
  docker run --rm -i \
    --network none \
    --read-only \
    --tmpfs "/tmp:rw,noexec,nosuid,nodev,mode=1777,size=${tmpfs_size}" \
    --user 1000:1000 \
    --cap-drop ALL \
    --security-opt no-new-privileges:true \
    --pids-limit 128 \
    --workdir /tmp \
    "$image" \
    bash -euo pipefail -c "$container_script"
}

cmd_build() {
  setup_engine
  [[ -d "$context_dir" && ! -L "$context_dir" ]] || fail "missing or unsafe build context $context_dir"
  [[ -f "$dockerfile" && ! -L "$dockerfile" ]] || fail "missing or unsafe $dockerfile"
  [[ -f "$validator_file" && ! -L "$validator_file" ]] || fail "missing or unsafe $validator_file"
  grep -Fq "$pinned_base" "$dockerfile" || fail "Dockerfile base image pin mismatch"

  printf '=== Building pinned Ark CI tools image (context: deploy/ark/ci-tools) ===\n'
  docker build -f "$dockerfile" -t "$image" "$context_dir"
  printf '=== CI tools image metadata (--network none, --read-only, UID 1000) ===\n'
  run_hardened 16m '
    v="'"$container_validator"'"
    [[ -f "$v" && ! -L "$v" && "$(stat -c "%u:%g:%a" "$v")" == "0:0:555" ]] || exit 1
    jq -n \
      --arg image "'"$image"'" \
      --arg base "'"$pinned_base"'" \
      --arg node "$(node --version)" \
      --arg git "$(git --version)" \
      --arg jq "$(jq --version)" \
      --arg bash "$(bash --version | head -n 1)" \
      --arg validator "$v" \
      --arg validator_sha256 "$(sha256sum "$v" | awk "{print \$1}")" \
      --argjson uid "$(id -u)" \
      "{image:\$image, base:\$base, node:\$node, git:\$git, jq:\$jq, bash:\$bash, validator:\$validator, validator_sha256:\$validator_sha256, uid:\$uid}"
  ' < /dev/null
}

ensure_image() {
  [[ -f "$validator_file" && ! -L "$validator_file" ]] || fail "missing or unsafe $validator_file"
  local expected_sha actual_sha=""
  expected_sha=$(sha256sum "$validator_file" | awk '{print $1}')
  if docker image inspect "$image" >/dev/null 2>&1; then
    actual_sha=$(run_hardened 16m '
      v="'"$container_validator"'"
      [[ -f "$v" && ! -L "$v" && "$(stat -c "%u:%g:%a" "$v")" == "0:0:555" ]] &&
        sha256sum "$v" | awk "{print \$1}"
    ' < /dev/null 2>/dev/null || true)
  fi
  if [[ "$actual_sha" != "$expected_sha" ]]; then
    cmd_build >&2
  fi
}

cmd_bootstrap_regression() {
  local if_present=0
  if [[ "${1:-}" == "--if-present" ]]; then
    if_present=1
    shift
  fi
  [[ $# == 0 ]] || fail "usage: docker-ci-checks.sh bootstrap-regression [--if-present]"

  setup_engine
  command -v tar >/dev/null || fail "missing tar CLI"
  [[ ! -L "$root/scripts" && ! -L "$root/scripts/ark" ]] || fail "symlink in scripts/ark path"

  if (( if_present == 1 )); then
    if [[ ! -f "$root/scripts/ark/test-bootstrap-funding.sh" || ! -f "$root/scripts/ark/bootstrap-funding.sh" ]] ||
       ! grep -Fq 'miner_history()' "$root/scripts/ark/common.sh"; then
      printf 'SKIPPED: test-bootstrap-funding.sh requires PR #63 bootstrap helpers\n'
      return 0
    fi
  fi

  local rel
  for rel in scripts/ark/common.sh scripts/ark/bootstrap-funding.sh scripts/ark/test-bootstrap-funding.sh; do
    [[ -f "$root/$rel" && ! -L "$root/$rel" ]] || fail "missing or unsafe required file: $rel"
  done
  grep -Fq 'miner_history()' "$root/scripts/ark/common.sh" ||
    fail "scripts/ark/common.sh lacks miner_history() helper"

  ensure_image
  printf '=== Running bootstrap funding Bash regression in pinned container (--network none, streamed input) ===\n'
  tar -C "$root" -cf - \
    scripts/ark/common.sh \
    scripts/ark/bootstrap-funding.sh \
    scripts/ark/test-bootstrap-funding.sh |
    run_hardened 16m '
      umask 077
      mkdir -m 0700 -p /tmp/work
      tar --no-same-owner -C /tmp/work -xf -
      chmod 0444 /tmp/work/scripts/ark/common.sh \
        /tmp/work/scripts/ark/bootstrap-funding.sh \
        /tmp/work/scripts/ark/test-bootstrap-funding.sh
      exec bash /tmp/work/scripts/ark/test-bootstrap-funding.sh
    '
}

cmd_secrets_check() {
  [[ $# == 0 ]] || fail "usage: docker-ci-checks.sh secrets-check"

  setup_engine
  command -v git >/dev/null || fail "missing git CLI"
  command -v tar >/dev/null || fail "missing tar CLI"
  [[ ! -L "$root/scripts" && -f "$root/scripts/check-secrets.mjs" && ! -L "$root/scripts/check-secrets.mjs" ]] ||
    fail "missing or unsafe scripts/check-secrets.mjs"

  local git_dir_raw git_common_raw git_dir git_common_dir obj_fmt ref_fmt
  git_dir_raw=$(git -C "$root" rev-parse --git-dir) || fail "not a git repository"
  git_common_raw=$(git -C "$root" rev-parse --git-common-dir) || fail "cannot resolve git common dir"
  git_dir=$(cd -- "$root" && cd -- "$git_dir_raw" && pwd -P)
  git_common_dir=$(cd -- "$root" && cd -- "$git_common_raw" && pwd -P)

  [[ -d "$git_common_dir/objects" && ! -L "$git_common_dir/objects" ]] || fail "missing or unsafe git objects dir"
  [[ -d "$git_common_dir/refs" && ! -L "$git_common_dir/refs" ]] || fail "missing or unsafe git refs dir"
  [[ -f "$git_dir/HEAD" && ! -L "$git_dir/HEAD" ]] || fail "missing or unsafe git HEAD"
  [[ ! -s "$git_common_dir/objects/info/alternates" ]] ||
    fail "git object alternates are not supported in isolated streamed scan"

  obj_fmt=$(git -C "$root" config --get extensions.objectformat 2>/dev/null || true)
  [[ -z "$obj_fmt" || "$obj_fmt" == "sha1" ]] ||
    fail "unsupported git extensions.objectformat=$obj_fmt"
  ref_fmt=$(git -C "$root" config --get extensions.refstorage 2>/dev/null || true)
  [[ -z "$ref_fmt" || "$ref_fmt" == "files" ]] ||
    fail "unsupported git extensions.refstorage=$ref_fmt"

  # Stream strictly read-only Git object/ref/index metadata and the scanner script.
  # Explicitly exclude .git/config, .git/hooks, working-tree files, data/, and .env*.
  local -a tar_args=(-cf - -C "$git_common_dir" objects refs)
  if [[ -f "$git_common_dir/packed-refs" && ! -L "$git_common_dir/packed-refs" ]]; then
    tar_args+=(packed-refs)
  fi
  if [[ -f "$git_common_dir/shallow" && ! -L "$git_common_dir/shallow" ]]; then
    tar_args+=(shallow)
  fi
  if [[ "$git_dir" != "$git_common_dir" && -d "$git_dir/refs" && ! -L "$git_dir/refs" ]]; then
    tar_args+=(-C "$git_dir" refs)
  fi
  tar_args+=(-C "$git_dir" HEAD)
  if [[ -f "$git_dir/index" && ! -L "$git_dir/index" ]]; then
    tar_args+=(index)
  fi
  tar_args+=(-C "$root" scripts/check-secrets.mjs)

  ensure_image
  printf '=== Running Git secret hygiene scan in pinned container (--network none, full-history stream) ===\n'
  tar "${tar_args[@]}" |
    run_hardened 512m '
      umask 077
      mkdir -m 0700 -p /tmp/work/.git /tmp/work/scripts
      tar --no-same-owner -C /tmp/work/.git -xf -
      mv /tmp/work/.git/scripts/check-secrets.mjs /tmp/work/scripts/check-secrets.mjs
      rmdir /tmp/work/.git/scripts
      chmod 0444 /tmp/work/scripts/check-secrets.mjs
      printf "[core]\n\trepositoryformatversion = 0\n\tbare = false\n" > /tmp/work/.git/config
      cd /tmp/work
      exec env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE \
        GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
        node /tmp/work/scripts/check-secrets.mjs
    '
}

cmd_evidence_validator_regression() {
  [[ $# == 0 ]] || fail "usage: docker-ci-checks.sh evidence-validator-regression"

  setup_engine
  command -v tar >/dev/null || fail "missing tar CLI"
  [[ ! -L "$root/scripts" && ! -L "$root/scripts/ark" ]] || fail "symlink in scripts/ark path"
  [[ -f "$root/scripts/ark/test-validate-e2e-evidence.sh" && ! -L "$root/scripts/ark/test-validate-e2e-evidence.sh" ]] ||
    fail "missing or unsafe scripts/ark/test-validate-e2e-evidence.sh"

  ensure_image
  printf '=== Running E2E evidence validator regression in pinned container (--network none, immutable in-image validator) ===\n'
  tar -C "$root" -cf - \
    scripts/ark/test-validate-e2e-evidence.sh |
    run_hardened 32m '
      umask 077
      mkdir -m 0700 -p /tmp/work
      tar --no-same-owner -C /tmp/work -xf -
      chmod 0444 /tmp/work/scripts/ark/test-validate-e2e-evidence.sh
      export ARK_EVIDENCE_VALIDATOR="'"$container_validator"'"
      exec bash /tmp/work/scripts/ark/test-validate-e2e-evidence.sh
    '
}

cmd_validate_e2e_evidence() {
  [[ $# == 2 ]] || fail "usage: docker-ci-checks.sh validate-e2e-evidence <source_dir> <approved_dir>"
  local src_arg=$1 dst_arg=$2 src dst dst_parent tmp_out
  case "$src_arg" in /*) src=$src_arg ;; *) src="$root/$src_arg" ;; esac
  case "$dst_arg" in /*) dst=$dst_arg ;; *) dst="$root/$dst_arg" ;; esac

  setup_engine
  command -v tar >/dev/null || fail "missing tar CLI"
  [[ ! -L "$dst" ]] || fail "refusing symlink approved directory: $dst"

  # Fail closed: clear stale approved dir even if source is missing or validation fails.
  if [[ -e "$dst" ]]; then
    [[ -d "$dst" && ! -L "$dst" ]] || fail "approved path exists and is not a directory: $dst"
    rm -rf -- "$dst"
  fi
  [[ -d "$src" && ! -L "$src" ]] || fail "missing or unsafe source evidence directory: $src"

  # Host-side strict allowlist and regular-file pre-flight BEFORE packing any tar input.
  # Never pack directories, symlinks, hidden files, or unapproved entries.
  local actual_sorted expected_sorted entry path size
  expected_sorted=$(printf '%s\n' "${approved_evidence_files[@]}")
  actual_sorted=$(find "$src" -mindepth 1 -maxdepth 1 -printf '%f\n' | LC_ALL=C sort)
  if [[ "$actual_sorted" != "$expected_sorted" ]]; then
    for entry in "${approved_evidence_files[@]}"; do
      if ! grep -Fxq "$entry" <<<"$actual_sorted"; then
        fail "missing required evidence file before streaming: $entry"
      fi
    done
    while IFS= read -r entry; do
      [[ -z "$entry" ]] && continue
      if ! grep -Fxq "$entry" <<<"$expected_sorted"; then
        fail "unexpected unapproved entry in evidence directory: $entry"
      fi
    done <<<"$actual_sorted"
    fail "evidence directory entries do not match strict allowlist"
  fi
  for entry in "${approved_evidence_files[@]}"; do
    path="$src/$entry"
    [[ -f "$path" && ! -L "$path" && -r "$path" ]] ||
      fail "evidence entry is not a readable regular file: $entry"
    size=$(wc -c < "$path")
    (( size > 0 && size <= 65536 )) ||
      fail "evidence file size out of bounds ($size bytes): $entry"
  done

  ensure_image
  dst_parent=$(dirname -- "$dst")
  mkdir -p -- "$dst_parent"
  [[ ! -L "$dst_parent" ]] || fail "refusing symlink parent for approved directory"
  tmp_out=$(mktemp -d "$dst_parent/.ark-approved-out.XXXXXXXX")
  chmod 0700 "$tmp_out"
  trap 'rm -rf -- "${tmp_out:-}"' RETURN

  printf '=== Validating E2E evidence inside pinned container (--network none, immutable in-image validator) ===\n' >&2
  local tar_in tar_out
  tar_in=$(mktemp "$tmp_out/.in.XXXXXXXX")
  # Stream ONLY the 6 allowlisted regular data files; never mix executable scripts with untrusted input.
  tar -C "$src" -cf "$tar_in" -- "${approved_evidence_files[@]}"
  tar_out=$(mktemp "$tmp_out/.out.XXXXXXXX")
  if ! run_hardened 32m '
    umask 077
    mkdir -m 0700 -p /tmp/work/src
    tar --no-same-owner -C /tmp/work/src -xf -
    summary=$(bash "'"$container_validator"'" /tmp/work/src /tmp/work/approved)
    printf "%s\n" "$summary" >&2
    tar -C /tmp/work/approved -cf - -- \
      boarding.json matrix.json offboard.json renewal.json restart.json transfer.json
  ' < "$tar_in" > "$tar_out"; then
    fail "E2E evidence validation failed closed; no approved artifacts staged"
  fi

  # Verify container stdout is a clean tar archive containing ONLY the 6 allowlisted regular files.
  local out_entries out_types
  out_entries=$(tar -tf "$tar_out" | LC_ALL=C sort) || fail "invalid tar stream from validator container"
  [[ "$out_entries" == "$expected_sorted" ]] ||
    fail "unexpected entries in approved tar stream"
  out_types=$(tar -tvf "$tar_out") || fail "cannot inspect approved tar stream"
  if grep -Ev '^-[rwx-]{9} ' <<<"$out_types" | grep -q .; then
    fail "non-regular member detected in approved tar stream"
  fi

  mkdir -m 0700 -p -- "$tmp_out/approved"
  tar --no-same-owner -C "$tmp_out/approved" -xf "$tar_out"
  for entry in "${approved_evidence_files[@]}"; do
    [[ -f "$tmp_out/approved/$entry" && ! -L "$tmp_out/approved/$entry" ]] ||
      fail "approved output is not a regular file: $entry"
    chmod 0600 "$tmp_out/approved/$entry"
  done
  mv -- "$tmp_out/approved" "$dst"
  rm -rf -- "$tmp_out"
  trap - RETURN
}

cmd_all() {
  local if_present_arg=()
  if [[ "${1:-}" == "--if-present" ]]; then
    if_present_arg=(--if-present)
    shift
  fi
  [[ $# == 0 ]] || fail "usage: docker-ci-checks.sh all [--if-present]"
  cmd_build
  cmd_bootstrap_regression "${if_present_arg[@]}"
  cmd_evidence_validator_regression
  cmd_secrets_check
}

case "${1:-}" in
  build) shift; [[ $# == 0 ]] || fail "usage: docker-ci-checks.sh build"; cmd_build ;;
  bootstrap-regression) shift; cmd_bootstrap_regression "$@" ;;
  evidence-validator-regression) shift; cmd_evidence_validator_regression "$@" ;;
  validate-e2e-evidence) shift; cmd_validate_e2e_evidence "$@" ;;
  secrets-check) shift; cmd_secrets_check "$@" ;;
  all) shift; cmd_all "$@" ;;
  *)
    fail "usage: docker-ci-checks.sh <build|bootstrap-regression [--if-present]|evidence-validator-regression|validate-e2e-evidence <src> <dst>|secrets-check|all [--if-present]>"
    ;;
esac
