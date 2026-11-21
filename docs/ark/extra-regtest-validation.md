# Validación adicional de Ark/regtest — 2026-11-18

Código base probado: `9df9f6f08eb78e6cd6a48c7a349fdf8806fd890d`, rama `ark-regtest-46-54`. Comandos ejecutados desde la raíz del worktree con Rust `1.97.1`, Node `v22.23.2`, npm `10.9.8`, Podman `4.3.1` y `podman-compose 1.6.0` en local. El [runbook](regtest-runbook.md) lista los prerrequisitos; la [revisión de seguridad](security-review.md) detalla el límite de confianza y los hallazgos.

## 1. Comprobaciones sin stack (offline, mocks y skips)

| Comando exacto | Estado | Alcance y separación mock / real / skip |
| --- | --- | --- |
| `cargo fmt --manifest-path ark/Cargo.toml --all -- --check` | `PASS` (exit 0) | Sin diferencias de formato. |
| `cargo clippy --manifest-path ark/Cargo.toml --locked --all-targets --all-features -- -D warnings` | `PASS` (exit 0) | Sin advertencias en todos los targets/features. |
| `npm run ark:test -- --unit-only` | `PASS` (exit 0) | **Unitarias Rust (`src/lib.rs`)**: `5 passed, 0 failed` (almacenamiento/permisos/lock, symlinks, dirección regtest, operador inaccesible sin mock server, y timeout sintético `simulated_offboard_submission_timeout_is_uncertain`). **`src/main.rs`**: `0 tests`. **`adapter_contract`**: `4 passed, 0 failed` con backend **`DeclaredMock`** (replay idempotente, validación de quote, recuperación de transferencia incierta y regresión por reorg sin red). **Bash (`test-bootstrap-funding.sh`)**: `PASS` con **RPC simulado** (paginación, fallo RPC, conflicto, acuse perdido/recuperación y `gettxout` estricto). **`adapter_arkd_read`**: `1 ignored` (**`SKIP`** offline). |
| `npm run secrets:check` | `PASS` (exit 0) | Escaneo del índice y blobs históricos sin hallazgos (`findings: 0`). |

## 2. Ejecución contra el stack aislado en regtest

| Comando exacto | Estado | Resultado observado (regtest real vs skip) |
| --- | --- | --- |
| `npm run ark:start` | `PASS` (exit 0) | Reutilizó volúmenes del laboratorio; Bitcoin Core en regtest (`0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206`) altura 118 (`31fd34d2507164cd7ee0813400aad41903f1b606ac28b1a37322e6437d461700`), indexadores sincronizados, PostgreSQL/Redis listos, signer saludable, `arkd v0.9.25` inicializado/desbloqueado/sincronizado (`20.99119556` BTC en `mainAccount`). |
| `npm run ark:status` | `PASS` (exit 0) | Confirmó salud del stack y los mismos parámetros en `http://127.0.0.1:37070/v1/info`. |
| `cargo test --manifest-path ark/Cargo.toml --locked -p ark-lab --test adapter_arkd_read -- --ignored --nocapture` | `PASS` (exit 0) | **En vivo (lectura SDK real sobre fixture de #54)**: `1 passed, 0 failed`; `arkd v0.9.25: dust=330 sats, Alice total=125000 sats, 3 VTXOs`, renewal `0a75ca25e28aa3df7889d5048255bfc61cfbf029f2a011ad932e60b30fbf177b:0`. |
| `npm run ark:test -- --e2e` (sobre `data/ark/e2e` existente) | Guard esperado (exit 1) | Rechazo explícito del fence one-shot antes de fondear (`fixture already claimed; inspect original state, never repeat funding`). |
| `npm run ark:test -- --e2e` (tras archivar `data/ark/e2e` → `data/ark/e2e-pr54`) | `PASS` (exit 0) | **En vivo (9 etapas `PASSED`, 2 `SKIPPED`)**: `boarding`, `boarding_operator_outage`, `transfer_and_client_restart`, `cooperative_offboard`, `stale_vtxo_and_renewal`, `operator_unavailable`, `operator_restart`, `rpc_unavailable`, `indexer_unavailable` en **`PASSED`**; `unilateral_exit` y `live_mutation_timeout` en **`SKIPPED`**. |
| `cargo test --manifest-path ark/Cargo.toml --locked -p ark-lab --test adapter_arkd_read -- --ignored --nocapture` | `PASS` (exit 0) | **En vivo (sobre el fixture recién generado)**: `1 passed, 0 failed`; `Alice total=125000 sats, 3 VTXOs`, renewal `71a574dd21b3f208b1f9f445341a0da81163715cc7b4857991f122340d80ffc6:0`. |
| `npm run ark:stop` | `PASS` (exit 0) | Detuvo los 9 contenedores del stack (`ark_lab_*`); 0 contenedores activos del worktree al finalizar. |

### Artefactos e identificadores públicos de la corrida E2E en vivo

- **Boarding (`boarding.json`)**: fondeo `a2cc69ded323b84f285e182bd7534eb3a13cd8c1436747dde5c1fe7eff635bc9:1` (altura 119, fee cadena 165 sats); compromiso `9f348a9153115bf6f33c65842831eff53c657e148f4304361df43be6d965f6a4` (altura 120, fee cadena 262 sats); VTXO `f0a8a779f0589791d8cea4285e7db722cb1f7052dc3dd017f4747646dadcf490:0`, `200,000` sats, `boarding_fee_sats: 0`.
- **Transfer y recuperación tras reinicio (`transfer.json`)**: `ark_txid` `bf025a2d2714c413568a3bb29df7e0aa70b588ad63e8492c3423db8121f995cf`; Alice `125,000` sats, Bob `75,000` sats, `fee_sats: 0`, preconfirmación finalizada recuperando el TXID desde `pending`.
- **Offboarding cooperativo (`offboard.json`)**: compromiso `abebe89ae8244bff5b7c5968ff19246370e9050ebcc3fbdd1e6e59dd58f95449` (altura 121, fee cadena 241 sats); salida `:2` de `30,000` sats a `bcrt1p26xsajjhlef4wvua7x5372ut8y06s90gcdynyjnjuwparh6ta56smxeexq`, cambio Ark `45,000` sats, `user_fee_sats: 0`.
- **Renovación de VTXO expirado (`renewal.json`)**: rechazo de VTXO vencido, compromiso de renovación `3d337a13f8bf79482458195358877a45390d26d52e87e3d579e579d05e55bd4c` (altura 122, fee cadena 198 sats); nuevo VTXO `71a574dd21b3f208b1f9f445341a0da81163715cc7b4857991f122340d80ffc6:0` de `125,000` sats.
- **No probado en vivo**: `unilateral_exit` (`SKIPPED`), `live_mutation_timeout` (`SKIPPED`, cubierto sólo de forma sintética en pruebas unitarias), Docker Engine en runner Ubuntu de GitHub Actions y pruebas de fuzzing/estrés concurrente.

## 3. Validación offline posterior al hardening de seguridad (#48–#64)

Tras aplicar los fixes de revisión en `ark/`, `scripts/ark/`, `deploy/ark/` y `.github/workflows/ark-lab-e2e.yml` (commits `ark(pr-48)` a `ark(pr-64)`), se re-verificó la suite offline sin servicios vivos:

| Comando exacto | Estado | Resultado observado |
| --- | --- | --- |
| `cargo fmt --manifest-path ark/Cargo.toml --all -- --check` | `PASS` (exit 0) | Sin diferencias de formato. |
| `cargo clippy --manifest-path ark/Cargo.toml --locked --all-targets --all-features -- -D warnings` | `PASS` (exit 0) | Sin advertencias en todos los targets/features. |
| `npm run ark:test -- --unit-only` | `PASS` (exit 0) | **Bash (`test-bootstrap-funding.sh`)**: `PASS` (incluye regresión de balance `"0.0"` y saldo negativo). **Unitarias `src/lib.rs`**: `9 passed, 0 failed` (añade traversal/missing contracts, `bounded_submission` timeout, cross-check `ArkAddress.server()`, y rechazo de cambio sub-dust en offboarding). **`src/main.rs`**: `1 passed, 0 failed` (`fixture_root_rejects_symlinked_ancestors`). **`adapter_contract`**: `5 passed, 0 failed` (añade rechazo de importes cero y direcciones no regtest en `Quote::validate_submission`). **`adapter_arkd_read`**: `1 ignored` (**`SKIP`** offline). |
| `npm run secrets:check` | `PASS` (exit 0) | Escaneo del índice y blobs históricos sin hallazgos (`findings: 0`). |

*Nota:* la ejecución E2E en vivo de la sección 2 corresponde al commit `9df9f6f`; la re-validación en vivo completa del laboratorio totalmente Dockerizado posterior al hardening y restauración de `f5742b0` está documentada en la sección 4.

## 4. Validación E2E en laboratorio Docker aislado — 2026-11-21

- **Fase 1 — Flujo E2E/build/unit (`21d3edb06d7b9ec59130ba61632540fd0dac6dd7`):** ejecutado desde proyecto dedicado limpio `swap-engine-ark-docker-e2e` en red privada `swap_engine_ark_e2e_net` (`internal: true`, 0 puertos host, sin `docker.sock`, sin `network_mode: host`, sin Rust/Cargo en host) sobre Commit 1 `855ab01` (PR `#61`) y Commit 2 `21d3edb` (PR `#63`, restauración `f5742b0`). Invariancia verificada: `git diff 21d3edb..167c120 -- ark/ deploy/ark/docker-compose.docker-e2e.yml scripts/ark/docker-e2e.sh` es vacío.
- **Fase 2 — Encapsulación de CI Ark sin Node ni regresión Bash en host (`167c120d09b18f7228aac50c50b6d1cde7e39206`):** `scripts/ark/docker-ci-checks.sh` y `.github/workflows/ark-lab-unit.yml` ejecutan `test-bootstrap-funding.sh` y `scripts/check-secrets.mjs` dentro de `swap-engine-ark-ci-tools:local` (`docker.io/library/node:24.22.3-bookworm-slim@sha256:dc26ae92...` + `bash`/`git`/`jq`, `--network none --read-only --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges:true --pids-limit 128`, entrada solo por stream `tar` sin bind mounts, sin `docker.sock` ni `.git/config`). Validado con `PATH` sin `node`/`npm`/`jq`/`cargo`: `PASS` + `findings: 0` (`176` archivos / `353` blobs en `167c120`, reconciliado con `162/336` en `21d3edb` y `173/348` en `5a9976b`).
- **Docker Engine + Docker Compose v2 nativos:** **`NO VALIDADO`** (no instalados ni activos en este host; validado sobre `podman 4.3.1` + `podman-compose 1.6.0`).
- **Registro completo (TXIDs, VTXOs, alturas, fees, reconciliación de escaneo, inventario PR `#56 → #64` y auditoría `70723af` vs `f5742b0` vs `backup/ark-full-0f17582`):** [docker-e2e-evidence.md](docker-e2e-evidence.md)
- **Informe PDF en español con 11 capturas reales de terminal GUI (`kitty` X11, diferenciadas por fase y SHA):** [ark-docker-e2e-report-es.pdf](evidence/docker-e2e/ark-docker-e2e-report-es.pdf)
- **Resumen:** `build` (`PASS`, `21d3edb`), `unit` offline `--network none` (`PASS`, `21d3edb`: `lib` 11/11, `main` 1/1, `adapter_contract` 5/5, `adapter_arkd_read` 1 ignored), `docker-ci-checks.sh all` contenerizado sin Node (`PASS`, `167c120`: regresión Bash `PASS` + `secrets:check` `findings: 0` en `176/353`, paridad exacta con host), `start`/`status` `chain=regtest` altura 102 (`PASS`, `21d3edb`), wallets A/B persistentes (`PASS`, `21d3edb`), matriz E2E en vivo (`PASS`, `21d3edb`: 10/10 etapas live + 2 `SKIPPED` explícitos), integración real `adapter_arkd_read` (`PASS`, `21d3edb`: `arkd v0.9.25`, Alice `125,000` sats, 3 VTXOs), negativo esperado de re-reclamo (`exit 1`, `21d3edb`), `restart-check` completo (`PASS`, `21d3edb`: 6/6 invariantes `true`, altura 106, 10 container IDs y 8 volúmenes idénticos) y parada final no destructiva (`PASS`, `21d3edb`).
