# Laboratorio Docker aislado: Arkade Rust SDK en regtest

**Solo Bitcoin regtest — sin mainnet, sin fondos reales y sin servicios Core/LND compartidos.**

Este laboratorio ejecuta **todo** el stack Bitcoin Core + Arkade + indexadores + bases de datos + compilación y ejecución del SDK oficial [`arkade-os/rust-sdk` v0.12.1](https://github.com/arkade-os/rust-sdk/tree/v0.12.1) (`352ca21bcaa01d3ddb535b0ebfb20cd9b028c357`) completamente dentro de Docker Compose.

## Requisitos en el host

- Únicamente **Docker Engine + Docker Compose v2** (o **Podman + `podman-compose`**), shell POSIX/Bash, `git` y `tar` (solo para transmitir el stream Git al escáner de secretos).
- No requiere Rust, `cargo`, `rustup`, `jq`, `curl`, `openssl`, `ss`, `node` ni `npm` en el host.
- Sin montaje de `docker.sock`, sin `network_mode: host`, sin puertos publicados en el host y sin bind mounts amplios.

## Arquitectura e invariantes de aislamiento

- **Proyecto dedicado:** `swap-engine-ark-docker-e2e` (`deploy/ark/docker-compose.docker-e2e.yml`).
- **Red privada exclusiva:** `swap_engine_ark_e2e_net` (`internal: true`, sin egreso a Internet en ejecución ni exposición de `37071`/`32838`/`38443` en loopback).
- **Volúmenes dedicados:** `swap_engine_ark_e2e_{bitcoin_data,postgres_data,nbxplorer_data,fulcrum_data,mariadb_data,mempool_cache,wallet_data,arkd_data,sdk_state}`, etiquetados con `io.swap-engine.ark.worktree` e `io.swap-engine.ark.lab=docker-e2e`.
- **Contenedor `ark-sdk` (`ark/Dockerfile`):** basado en `rust:1.97.1-slim-bookworm`, usuario no root `arklab` (`1000:1000`), `cap_drop: [ALL]`, `no-new-privileges:true`, contexto limitado estrictamente a `ark/` con `ark/.dockerignore`, compilación `--locked` y ejecución de pruebas `--offline` en runtime.
- **Contenedor `swap-engine-ark-ci-tools:local` (`deploy/ark/ci-tools/Dockerfile`):** basado en digest fijado `docker.io/library/node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54` + `bash`, `git`, `jq`, contexto aislado exclusivamente al `Dockerfile` (`deploy/ark/ci-tools/.dockerignore` descarta todo lo demás). Ejecuta tanto la regresión `test-bootstrap-funding.sh` como el escáner histórico `scripts/check-secrets.mjs` con `--network none`, `--read-only`, `--tmpfs /tmp:rw,noexec,nosuid,nodev`, `--user 1000:1000`, `--cap-drop ALL`, `--security-opt no-new-privileges:true`, `--pids-limit 128` y entrada exclusivamente por stream `tar` en `stdin` (cero bind mounts, cero `docker.sock`, sin `.git/config`, sin `.git/hooks`, sin `data/` ni `.env`).
- **Allowlist de red en Rust (`ARK_LAB_NETWORK_MODE`):** `ark-lab` sólo acepta `loopback` (`127.0.0.1:37070` / `127.0.0.1:33000/api`) o `docker` (`http://arkd:7070` / `http://mempool_api:8999/api`). Cualquier otro valor falla cerrado (`ArkNetworkMismatch`).
- **Protección de secretos y fixtures:** `data/ark/docker-e2e/compose.env` se genera con permisos `0600` (excluido de Git y del contexto Docker), la contraseña del wallet del operador se envía por stdin sin argv ni entorno de `ark-sdk`, las wallets y fences residen en el volumen dedicado `sdk_state` (`0700`/`0600`), y sólo los JSON públicos saneados se exportan a `data/ark/docker-e2e/evidence/`.
- **Restart y stop no destructivos:** `stop` nunca ejecuta `down -v` ni borra volúmenes, wallets ni fences; `start` usa `--no-recreate`.

## Comandos reproducibles

Desde la raíz del worktree:

```sh
# 1. Compilar imagen reproducible del SDK Rust oficial (--locked)
bash scripts/ark/docker-e2e.sh build

# 2. Pruebas unitarias y de contrato offline (sin servicios vivos)
bash scripts/ark/docker-e2e.sh unit

# 3. Regresión Bash de bootstrap y escaneo histórico de secretos en contenedor fijado (sin Node ni jq en host)
bash scripts/ark/docker-ci-checks.sh all
# Subcomandos individuales:
#   bash scripts/ark/docker-ci-checks.sh build
#   bash scripts/ark/docker-ci-checks.sh bootstrap-regression [--if-present]
#   bash scripts/ark/docker-ci-checks.sh secrets-check

# 4. Arrancar stack regtest aislado, validar salud y chain=regtest
bash scripts/ark/docker-e2e.sh start
bash scripts/ark/docker-e2e.sh status

# 5. Verificar wallets A/B persistentes (independientes del fixture E2E)
bash scripts/ark/docker-e2e.sh wallets

# 6. Ejecutar matriz E2E en vivo + integración real contra arkd
bash scripts/ark/docker-e2e.sh e2e

# 7. Verificar integración real SDK -> arkd de forma aislada (requiere #63 / adapter_arkd_read.rs)
bash scripts/ark/docker-e2e.sh integration

# 8. Verificar persistencia completa tras parada y reinicio no destructivo
bash scripts/ark/docker-e2e.sh restart-check

# 9. Parada final no destructiva
bash scripts/ark/docker-e2e.sh stop
```

## Separación CI

- `.github/workflows/ark-lab-unit.yml`: ejecuta `build` y `unit` dentro del contenedor `ark-sdk` sin servicios vivos, y ejecuta `bootstrap-regression --if-present` y `secrets-check` dentro del contenedor fijado `swap-engine-ark-ci-tools:local` sin `actions/setup-node`, sin `npm` en el host y sin ejecución directa de scripts Bash en el host.
- `.github/workflows/ark-lab-e2e.yml`: flujo `workflow_dispatch` opt-in (`run_e2e: true`), ejecuta la matriz completa y sube exclusivamente los JSON públicos permitidos tras verificar ausencia de tokens sensibles.
- `.github/workflows/ci.yml` (CI de Node del motor): sin cambios.

## Límites explícitos

- `unilateral_exit` (`SKIPPED`): no implementado ni expuesto en `ark-lab` (requiere `submitpackage`, árboles/checkpoints, CPFP y espera CSV).
- `live_mutation_timeout` (`SKIPPED`): cubierto únicamente mediante simulación unitaria (`bounded_submission_timeout_is_uncertain` y `simulated_offboard_submission_timeout_is_uncertain`), no mediante retardo real inyectado en medio de una ronda.
- Pruebas de `ArkAdapter` (`adapter_contract` y `adapter_arkd_read`) y `test-bootstrap-funding.sh` dependen del stack con PR #63 (`#54`); en árboles previos a #63, la etapa `adapter_arkd_read` y `bootstrap-regression --if-present` se marcan explícitamente `SKIPPED`.
- **Docker Engine + Docker Compose v2 nativos:** `NO VALIDADO` en este host local (el host dispone únicamente de Podman `4.3.1` + `podman-compose 1.6.0` y no tiene instalado `dockerd`/`docker-ce`/`docker-compose-plugin`).
