# Evidencia E2E Docker: Arkade Rust SDK en regtest (`Truja503/swap-engine`)

**Solo Bitcoin regtest — sin mainnet, sin fondos reales y sin servicios Core/LND compartidos.**

> **Alcance explícito:** estas pruebas controladas cubren exclusivamente el laboratorio aislado `ark-lab` sobre Bitcoin regtest (operador `arkd`, wallets A/B, boarding, transferencia Ark A→B, offboarding cooperativo, renovación de VTXO expirado, lecturas de `ArkAdapter` y rutas CI contenerizadas). **NO constituyen evidencia de swaps Ark↔Lightning, ni de swaps Lightning→onchain, ni de integración con el motor Node, rutas admin ni interfaz web** (`main`, `.github/workflows/ci.yml`, `scripts/check-secrets.mjs` y `package.json` permanecen intactos).

Informe técnico reproducible de la implementación, endurecimiento P1/P2, distribución por capas de PRs (`#62 → #61 → #63 → #64`) y ejecución desde estado limpio del laboratorio Docker aislado para el SDK oficial [`arkade-os/rust-sdk` v0.12.1](https://github.com/arkade-os/rust-sdk/tree/v0.12.1) (`352ca21bcaa01d3ddb535b0ebfb20cd9b028c357`).

- **Informe PDF en español (con 11 capturas reales de terminal GUI preservadas por fase y SHA, más registro Fase 3 de distribución):** [ark-docker-e2e-report-es.pdf](evidence/docker-e2e/ark-docker-e2e-report-es.pdf)
- **Directorio estable de capturas PNG reales:** `docs/ark/evidence/docker-e2e/screenshots/`
- **Guía reproducible del laboratorio Docker:** [docker-lab.md](docker-lab.md)

---

## 1. Trazabilidad Git por Fase, Distribución por Capas y Entorno

### 1.1 Fases históricas (`ark-docker-e2e`, preservadas sin reetiquetar)

| Campo | Valor verificado |
| --- | --- |
| Repositorio / Worktree histórico | `Truja503/swap-engine` — `/home/chelo/orca/workspaces/swap-engine/ark-docker-e2e` (rama local `ark-docker-e2e`, sin `push`) |
| Base de partida (`ark-regtest-46-54`) | `70723afc66e95ac0c31bdea74b2a143f8bec668b` |
| Commit 1 (origen PR `#61` / `#53` Docker/harness/CI) | `855ab01ded8bddbc2921aed583c36814fced0704` |
| Commit 2 (origen PR `#63` / `#54` restauración `f5742b0`) | `21d3edb06d7b9ec59130ba61632540fd0dac6dd7` (**Fase 1 — SHA histórico probado en vivo; capturas `01`–`09.png`**) |
| Commit 3 (origen PR `#64` evidencia inicial) | `5a9976bfe9f842eb9f8dd1451e8edf6f7d25efad` (añadió 11 archivos de evidencia + modificó `extra-regtest-validation.md`) |
| Commit 4 (origen PR `#61` encapsulación CI sin host Node/Bash) | `167c120d09b18f7228aac50c50b6d1cde7e39206` (**Fase 2 — SHA histórico probado para `docker-ci-checks.sh` y `ark-lab-unit.yml`; capturas `10`–`11.png`**) |
| Commit 5 (origen PR `#64` actualización evidencia/PNG/PDF) | `e52b3aa93f42700c11836e6ee6949f083fd474ee` (`git diff 167c120..e52b3aa -- ark/ deploy/ scripts/ .github/` vacío) |
| Invariancia histórica Fase 1 (`21d3edb → 167c120`) | `git diff 21d3edb..167c120 -- ark/ deploy/ark/docker-compose.docker-e2e.yml scripts/ark/docker-e2e.sh` **vacío (0 archivos modificados)** |
| Fechas de ejecución histórica | **Fase 1 (`21d3edb`):** `2026-11-21` (`12:12`–`12:25 -06:00`); **Fase 2 (`167c120`):** `2026-11-21` (`12:55`–`12:56 -06:00`) |

### 1.2 Fase 3 — Revisión de distribución por capas y endurecimiento P1/P2 (`ark-pr-distribution`)

| Campo | Valor verificado |
| --- | --- |
| Worktree de distribución | `/home/chelo/orca/workspaces/swap-engine/ark-pr-distribution` (candidatos locales FF sobre heads de `marchelo23/swap-engine`) |
| Candidato `#62` (`tmp/pr-62-candidate`, FF sobre `1d4f1e0`) | `59319af4c2c06d4a2fe2e89c4226378d0be29783` (**P2:** elegibilidad explícita previa a mutación en `ark/ark-lab/src/offboard.rs` + 4 tests unitarios; `1` archivo) |
| Candidato `#61` (`tmp/pr-61-candidate`, FF sobre `a907fc8`) | `62eca45d450b39a165283424f2a3c0682bd48cba` (conserva `c7724de6b403bd8f728e06f6c27e464ca44c86bb` y `b143790c28b72241baf069a9b7b534499fc47fa4`; merge limpio de `#62` `e4e0882d`; **P1:** validador fail-closed inmutable `/usr/local/libexec/ark-validate-e2e-evidence.sh` `0:0:555` en imagen `ci-tools`, pre-filtro allowlist antes de `tar`, `stdout` tar limpio, upload condicionado en `ark-lab-e2e.yml` sin `always()`, instancia aislable `ARK_E2E_INSTANCE` y fix Podman 4.3.1 multi-label OR; sin `ArkAdapter` ni evidencia `#64`) |
| Candidato `#63` (`tmp/pr-63-candidate`, FF sobre `09960c8`) | `ba319b35423a16ac2bf07b8123be1f1e6806bcfc` (**Fase 3 — SHA final de código probado en vivo:** merge `#61` + cherry-pick `21d3edb` en `4651ccd` + restauración `4fee198` `require_regtest()` en `Board`/`SettleVtxo` en `50a5f69` + propagación FF de `#61` `62eca45d`) |
| Candidato `#64` (`tmp/pr-64-candidate`, FF sobre `70723af`) | Merge de `#63` (`ba319b35`) + cherry-pick `5a9976b` (`7693824`) + cherry-pick `e52b3aa` (`3f646c0`) + commit final de documentación/PDF sobre `3f646c078e7e5c52506d076c701fd2e5e2bb5011` (`git diff tmp/pr-63-candidate..HEAD -- ark/ deploy/ scripts/ .github/` vacío) |
| Diferencias funcionales finales vs `e52b3aa` | Limitadas estrictamente a **P1** (validador fail-closed + imagen `ci-tools` inmutable + workflow `ark-lab-e2e.yml`/`ark-lab-unit.yml` + `ARK_E2E_INSTANCE`/fix Podman en `docker-e2e.sh`) y **P2** (`ark/ark-lab/src/offboard.rs`). **0 deriva** en `lib.rs`, `main.rs`, `transfer.rs`, `blockchain.rs`, `adapter.rs`, `adapter_contract.rs` ni `adapter_arkd_read.rs`. |
| Fecha de ejecución en vivo Fase 3 (`ba319b35`) | `2026-11-21` (`15:45`–`16:12 -06:00`) |
| Proyecto / Red / Volúmenes dedicados Fase 3 | `ARK_E2E_INSTANCE=dist` → proyecto `swap-engine-ark-docker-e2e-dist`, red privada `swap_engine_ark_e2e_dist_net` (`internal: true`), 8 volúmenes dedicados (`swap_engine_ark_e2e_dist_*`), 0 puertos host; los 8 volúmenes históricos `swap_engine_ark_e2e_*` de `ark-docker-e2e` permanecieron intactos. |

### 1.3 Entorno y versiones fijadas

| Campo | Valor verificado |
| --- | --- |
| Sistema operativo host | `Linux 6.12.74+deb12-amd64 x86_64 GNU/Linux` (X11 `:0`, Qtile, `kitty` GUI real) |
| Motor de contenedores validado localmente | `podman 4.3.1` (wrapper CLI `docker`) / `podman-compose 1.6.0` |
| **Docker Engine + Docker Compose v2 nativos** | **`NO VALIDADO`** — `dockerd` no instalado, `/usr/libexec/docker/cli-plugins` ausente, `systemctl is-active docker` = `inactive`, `/run/docker.sock -> /run/podman/podman.sock` |
| **GitHub Actions Ubuntu (`ubuntu-latest`)** | **`NO VALIDADO`** en remoto desde este worktree |
| Toolchain Rust en imagen `ark-sdk` | `rustc 1.97.1 (8bab26f4f 2026-07-14)` / `cargo 1.97.1 (c980f4866 2026-06-30)` (`rust:1.97.1-slim-bookworm`) |
| Imagen fijada de herramientas CI (`swap-engine-ark-ci-tools:local`) | `docker.io/library/node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54` + `bash 5.2.15`, `git 2.39.5`, `jq 1.6`, UID `1000` (`node`), validador inmutable `/usr/local/libexec/ark-validate-e2e-evidence.sh` (`root:root`, `0555`, `sha256: bb0b83cc3a999cedf895004d2e3daf6c8ce0fc76112df384fa13221c8d1e89bf`), contexto `deploy/ark/ci-tools/` (`.dockerignore`: solo `Dockerfile` y `validate-e2e-evidence.sh`) |
| SDK Rust oficial fijado | `arkade-os/rust-sdk` v0.12.1 (`352ca21bcaa01d3ddb535b0ebfb20cd9b028c357`) |
| Stack de servicios fijados | Bitcoin Core `31.0`, `arkd`/`arkd-wallet`/`arkd-signer` `v0.9.25`, PostgreSQL `16`, NBXplorer `2.6.7`, Fulcrum `v2.1.1`, Mempool Backend (Esplora) `v3.3.1`, Redis `7-alpine` |

---

## 2. Inventario GitHub (`#56 → #64`), Cadena Real y Auditoría Forense

### 2.1 Cadena real de PRs abiertos en `Truja503/swap-engine` y progresión FF verificada

Orden real verificado por ancestría Git (`git merge-base --is-ancestor` en cadena completa): **`#56 → #59 (operador) → #58 → #57 (boarding) → #60 → #62 → #61 (Docker/CI) → #63 (restauración) → #64 (PDF/capturas/MD)`**:

| Orden real | PR | Rama (`head`) | SHA base verificado | SHA candidato final (FF) | Título real (contenido Git) | Estado / hallazgo verificado |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | `#56` | `ark/pr-47-architecture` | `224cf0d` | `224cf0d` *(sin cambios)* | `[ARK][01] #47 - Architecture, compatibility and implementation plan` | Coherente (`1/9`, `Refs #47`). |
| 2 | `#59` | `ark/pr-48-operator` | `1df4813` | `1df4813` *(sin cambios)* | `[ARK][02] #48 - Isolated Arkade regtest operator lifecycle` | **Cuerpo intercambiado con `#57`** en metadata original de PR. |
| 3 | `#58` | `ark/pr-49-wallets` | `e0b0ef5` | `e0b0ef5` *(sin cambios)* | `[ARK][03] #49 - Persistent Arkade SDK wallets A/B` | Cuerpo original dice "after `#57`" en vez de "after `#59`". |
| 4 | `#57` | `ark/pr-50-boarding` | `56998d0` | `56998d0` *(sin cambios)* | `[ARK][04] #50 - Regtest BTC boarding into Ark VTXO` | **Cuerpo intercambiado con `#59`** en metadata original de PR. |
| 5 | `#60` | `ark/pr-51-transfer` | `f075ee2` | `f075ee2` *(sin cambios)* | `[ARK][05] #51 - Ark regtest transfer and recovery` | Cuerpo original dice "after `#59`" en vez de "after `#57`". |
| 6 | `#62` | `ark/pr-52-offboarding` | `1d4f1e0` | **`59319af`** *(FF OK)* | `[ARK][06] #52 - Cooperative Ark offboarding to Bitcoin Core (regtest)` | Cuerpo original intercambiado con `#61`. **P2 aplicado en `59319af`:** elegibilidad explícita previa a mutación en `offboard.rs` (`1` archivo, `13/13` tests en `#62`). |
| 7 | `#61` | `ark/pr-53-harness-ci` | `a907fc8` | **`62eca45`** *(FF OK)* | `[ARK][07] #53 - Ark regtest harness, runbook and isolated CI` | Cuerpo original intercambiado con `#62`. Integra `c7724de`, `b143790`, merge `#62` (`59319af`) y **P1** (validador inmutable + upload condicionado sin `always()` + fix Podman); `0` archivos de `#63`/`#64`. |
| 8 | `#63` | `ark/pr-54-adapter-and-fixes` | `09960c8` | **`ba319b3`** *(FF OK)* | `[ARK][08] #54 - ArkAdapter contract, SDK read verification and review fixes` | Regresión histórica (`f5742b0` omitido en `09960c8`) corregida: merge `#61` (`62eca45`) + `21d3edb` + `require_regtest()` (`4fee198`). **SHA final probado en vivo.** |
| 9 | `#64` | `ark/pr-extra-security-validation` | `70723af` | *Candidato sobre `3f646c0`* *(FF OK)* | `[ARK][EXTRA] Regtest validation evidence and security review` | Merge `#63` (`ba319b3`) + `5a9976b` + `e52b3aa` + actualización final docs/PDF (solo `docs/ark/` sobre `#63`). |

> **Nota sobre `main` remoto:** `Truja503/swap-engine` tiene fusionado PR `#68` en `main` (`0cb84ed` / `578a81b`), mientras el stack Ark parte de `d5e88ef` (`PR #55`). No se tocó motor, Node CI (`.github/workflows/ci.yml`), `scripts/check-secrets.mjs`, rutas admin, web ni `package.json`.

### 2.2 Comparativa forense: publicado `70723af` vs `f5742b0` vs `backup/ark-full-0f17582` (`0f17582`)

Evidencia verificada con `git log`, `git diff 70723af backup/ark-full-0f17582`, `git show --stat f5742b0` y ejecución real sobre `70723af`:

- **Ancestría:** `backup/ark-full-0f17582` (`0f17582`, 22 commits sobre `main`) contiene `f5742b0` (`Fix Ark regtest review blockers and recovery checks`) y todos los commits de hardening `ark(pr-48)`..`ark(pr-64)`. En el stack publicado `70723af` (21 commits), `f5742b0` **no es ancestro** (`merge-base` con `backup/ark-full-0f17582` es `224cf0d`).
- **Correcciones preservadas en `70723af`:**
  - Hardening de seguridad de `ark(pr-48)`..`ark(pr-64)` en `wallet_store.rs`, `offboard.rs`, `adapter.rs`, `ark-lab-e2e.yml`, `deploy/ark/.gitignore`, `ark/.gitignore`, `bootstrap-funding.sh` (validación numérica con `jq`), `test-bootstrap-funding.sh` (casos `zero_float` y `negative_balance`) y `main.rs` (`checked_fixture_root`).
  - Sin embargo, en `70723af`, `scripts/ark/bootstrap-funding.sh` quedó huérfano (no invocado por `bootstrap-regtest.sh`) y `bash scripts/ark/test-bootstrap-funding.sh` falló realmente con `exit 1` (`bootstrap-funding.sh: line 9: miner_history: command not found`).
- **Correcciones perdidas en `70723af` (16 archivos de `f5742b0` + 1 hunk de `4fee198`, TODOS preservados en `backup/ark-full-0f17582` y distribuidos por capa):**

| Archivo | Qué se perdió en `70723af` (presente en `f5742b0` / `0f17582`) | Capa / commit en distribución |
| --- | --- | --- |
| `deploy/ark/docker-compose.regtest.yml` | Red bridge `host_access` (`swap_engine_ark_host_net`) requerida por Docker Engine para publicar puertos loopback. | PR `#63` (`4651ccd` / origen `21d3edb`) |
| `scripts/ark/common.sh` | `host_services`, `managed_services`, `assert_host_networks()`, `miner()`, `confirmed_utxo()`, `miner_history()`. | PR `#63` (`4651ccd` / origen `21d3edb`) |
| `scripts/ark/bootstrap-regtest.sh` | `assert_host_networks existing` e invocación de `bootstrap-funding.sh` con diario durable por slots `01..21`. | PR `#63` (`4651ccd` / origen `21d3edb`) |
| `scripts/ark/stop-regtest.sh` | Iteración sobre `managed_services` en parada. | PR `#63` (`4651ccd` / origen `21d3edb`) |
| `scripts/ark/test-regtest.sh` | Ejecución de `test-bootstrap-funding.sh` en `--unit-only`, `assert_host_networks all`, etapas `boarding_operator_outage` y `operator_restart`. | PR `#63` (`4651ccd` / origen `21d3edb`) |
| `scripts/ark/e2e-boarding.sh` | `assert_only_boarding_funding()`, `confirmed_utxo()`, prueba de caída `boarding_operator_outage`. | PR `#63` (`4651ccd` / origen `21d3edb`) |
| `scripts/ark/e2e-transfer.sh` | Descarte deliberado de acuse de `transfer-submit`, recuperación del TXID desde `pending`, `verify-spent` sin replay. | PR `#63` (`4651ccd` / origen `21d3edb`) |
| `scripts/ark/e2e-offboard.sh` | `confirmed_utxo()` y segundo `scantxoutset` midiendo delta real `0 -> 30000` sats. | PR `#63` (`4651ccd` / origen `21d3edb`) |
| `ark/ark-lab/src/lib.rs` (`require_regtest`) | `RegtestBlockchain::require_regtest()` en `Board`/`SettleVtxo` (proveniente de `4fee198`, perdido en `56998d0`). | **PR `#63` (`50a5f69`)** *(movido fuera de `#61` al adaptar `c7724de`)* |
| `ark/ark-lab/src/lib.rs`, `main.rs`, `transfer.rs` (`VerifySpent`) | `Action::VerifySpent(OutPoint)` solo lectura (`list_vtxos` + `spendable_offchain`) manteniendo `_sats: Option<u64>` oculto y `"rejected":true` para compatibilidad con `#61`. | PR `#61` (`c7724de` / origen `855ab01`) |
| `ark/ark-lab/tests/adapter_contract.rs` | `reserved_inputs`, `original_ark_txids` y 6 casos negativos `ObservedTransfer` en recuperación incierta. | PR `#63` (`4651ccd` / origen `21d3edb`) |
| `ark/rust-toolchain.toml` | Toolchain fijado `channel = "1.97.1"` (requerido por `ark/Dockerfile` para builds offline `--locked`). | PR `#61` (`c7724de` / origen `855ab01`) |
| `.github/workflows/ark-lab-unit.yml` | Ejecución contenerizada de `test-bootstrap-funding.sh`, `test-validate-e2e-evidence.sh` y `secrets:check` sin Node en host. | PR `#61` (`c7724de` + `b143790` + `02ba880` + `62eca45`) |
| `docs/ark/operator-regtest.md` | Documentación de migración de `host_access` y diario `data/ark/operator-funding/`. | PR `#63` (`4651ccd` / origen `21d3edb`) |
| `docs/ark/regtest-runbook.md` | Documentación de `boarding_operator_outage`, descarte de acuse, `verify-spent` solo lectura, `scantxoutset` y `operator_restart`. | PR `#63` (`4651ccd` / origen `21d3edb`) |

---

## 3. Resultados por Fase y Capa (Distinción Explícita de SHA sin Reetiquetado)

> **Garantía de no reetiquetado:** las capturas `01`–`09.png` corresponden exactamente a la Fase 1 histórica (`21d3edb`), y `10`–`11.png` a la Fase 2 histórica (`167c120`). Los endurecimientos P1 y P2 de la Fase 3 se probaron íntegramente por capa (`#62` `59319af`, `#61` `62eca45`, `#63` `ba319b3`) incluyendo una corrida completa en vivo desde estado limpio sobre **`ba319b35423a16ac2bf07b8123be1f1e6806bcfc`** en `ARK_E2E_INSTANCE=dist`.

### 3.1 Validación por capa de distribución (Fase 3)

| Capa / Rama | SHA probado | Comandos exactos | Exit | Resultado verificado |
| --- | --- | --- | ---: | --- |
| `#62` (`tmp/pr-62-candidate`) | `59319af4` | `cargo fmt --all -- --check && cargo clippy --locked --all-targets --all-features -- -D warnings && cargo test --locked --lib --tests` | `0` | **PASS** — `src/lib.rs`: **13 passed, 0 failed** (incluye 4 nuevos tests P2 en `offboard.rs`: apto confirmado/preconfirmado/signer co-firmable, vencido, consumido, recuperable/swept/sub-dust/unrolled/cutoff/sin-forfeit/assets); `src/main.rs`: `0 tests`. Diff exclusivo: `ark/ark-lab/src/offboard.rs`. |
| `#61` (`tmp/pr-61-candidate`, sin `ArkAdapter`) | `02ba880d` → `62eca45d` | `docker-e2e.sh build`, `docker-e2e.sh unit`, `has-integration-test`, `docker-ci-checks.sh all --if-present` y pruebas E2E del wrapper real `validate-e2e-evidence` (PATH sin `node`/`npm`/`jq`/`cargo`) | `0` | **PASS** — `ark-sdk` (`fmt`/`build --locked`/`clippy -D warnings`) OK; unit offline `--network none`: `lib` **15/15**, `main` **1/1**; `has-integration-test` exit `1` (esperado sin `#63`); `bootstrap-regression --if-present` **`SKIPPED`**; `evidence-validator-regression` **PASS** (sobre `/usr/local/libexec/ark-validate-e2e-evidence.sh` inmutable `0:0:555`); wrapper real `validate-e2e-evidence`: válido exit `0` (`stdout` 0 bytes, tar contenedor 6 entradas regulares exactas), faltante exit `1`, dir extra benigno exit `1`, archivo extra exit `1`, esquema inválido exit `1`; `secret_scan` `160/599`, `findings: 0`. |
| `#63` (`tmp/pr-63-candidate`, con `ArkAdapter` + restauración + P1/P2) | `ba319b35` | `docker-e2e.sh build`, `docker-e2e.sh unit`, `docker-ci-checks.sh all`, y corrida regtest aislada completa `ARK_E2E_INSTANCE=dist` (`start`, `status`, `wallets`, `e2e`, `integration`, guard negativo, `restart-check`, `stop`, `validate-e2e-evidence`) | `0` | **PASS** — `unit` offline: `lib` **15/15**, `main` **1/1**, `adapter_contract` **5/5**, `adapter_arkd_read` **1 ignored**; `docker-ci-checks.sh all`: `bootstrap-regression` **PASS**, `evidence-validator-regression` **PASS**, `secret_scan` `166/599`, `findings: 0`; live E2E: **10/10 etapas live `PASSED` + 2 `SKIPPED`**, negativos P2 en vivo (consumido y vencido/recuperable → `ArkInputNotSpendable`), `adapter_arkd_read` **1/1 live**, re-reclamo `exit 1`, `restart-check` 6/6 invariantes `true`, `stop` no destructivo, y validador P1 contenedor sobre los 6 JSON vivos **`PASSED`**. |

### 3.2 Endurecimiento P1 (`#61` `62eca45d`) y P2 (`#62` `59319af4`)

- **P1 — Validación fail-closed de artefactos E2E y separación de namespaces (`#61` `62eca45d`):**
  - El validador canónico `deploy/ark/ci-tools/validate-e2e-evidence.sh` queda empaquetado de forma inmutable dentro de `swap-engine-ark-ci-tools:local` en `/usr/local/libexec/ark-validate-e2e-evidence.sh` (`root:root`, `0555`, rootfs `--read-only`, UID `1000`, `sha256: bb0b83cc3a999cedf895004d2e3daf6c8ce0fc76112df384fa13221c8d1e89bf`; `ensure_image()` verifica propietario, permisos y hash antes de ejecutar).
  - `cmd_validate_e2e_evidence` valida en host ANTES de empaquetar `tar` la allowlist exacta de 6 archivos regulares (`boarding.json`, `matrix.json`, `offboard.json`, `renewal.json`, `restart.json`, `transfer.json`), rechazando faltantes, archivos extra, subdirectorios, symlinks y tamaños fuera de `(0, 65536]`. Transmite solo los 6 archivos de datos hacia `/tmp/work/src` (`noexec`) y jamás ejecuta nada desde el directorio de evidencia.
  - Verifica con `jq` esquemas estrictos (claves exactas, tipos, valores permitidos en `regtest`, `unilateral_exit == "SKIPPED"`, `live_mutation_timeout == "SKIPPED"`), ausencia de bytes NUL, caracteres de control/logs multilínea y patrones de secretos; verifica que el `stdout` del contenedor sea un `tar` limpio de 6 archivos regulares exactos (`tar -tf` y `tar -tvf`).
  - `.github/workflows/ark-lab-e2e.yml` conserva únicamente el teardown (`stop`) con `if: always()`, elimina `upload always()`, ejecuta `validate_evidence` bajo `if: ${{ success() }}` y condiciona explícitamente `upload-artifact` (`if-no-files-found: error`) a `if: ${{ steps.validate_evidence.outcome == 'success' }}` publicando solo `data/ark/docker-e2e/evidence-approved/*.json`.
- **P2 — Elegibilidad explícita previa a mutación en offboarding cooperativo (`#62` `59319af4`):**
  - `ark/ark-lab/src/offboard.rs` reemplaza la confianza implícita en `list.all_unspent()` (que en `arkade-os/rust-sdk` v0.12.1 incluye VTXOs `is_recoverable`: expirados, barridos o sub-dust) por `check_cooperative_vtxo_eligibility(...)` antes de invocar `collaborative_redeem_vtxo_selection`: rechaza `is_spent`, `is_unrolled`, `is_swept`, vencidos (`now > expires_at || is_expired()`), recuperables (`is_recoverable(info.dust)` / `!is_spendable_offchain(info.dust)`), firmante deprecado pasado su `cutoff_date` (`signer_requires_recovery_at`), ausencia de `server_pk` o de ruta `SpendPathKind::Forfeit` (`ArkInputNotSpendable`) y activos no-BTC (`ArkUnsupportedAsset`); acepta VTXOs confirmados y preconfirmados aptos.
  - Verificado tanto mediante 4 pruebas unitarias dedicadas en `#62`/`#61`/`#63` como **en vivo contra `arkd v0.9.25`** en `docker-e2e.sh` (etapa 4 offboarding cooperativo normal con VTXO apto `PASS`, y etapa 7 rechazo `ArkInputNotSpendable` tanto para el VTXO consumido como para el VTXO expirado/recuperable de Bob antes de cualquier mutación).

### 3.3 Resumen histórico por etapa (Fases 1 y 2 · `21d3edb` / `167c120`, preservado íntegro)

| # | Etapa / Comprobación | Fase / SHA probado | Comando exacto | Exit | Estado | Captura real PNG |
| ---: | --- | --- | --- | ---: | --- | --- |
| 1 | Build imagen SDK Rust (`--locked`, `rustfmt`, `clippy`) | Fase 1 (`21d3edb`, inalterado en `167c120`) | `bash scripts/ark/docker-e2e.sh build` | `0` | **PASS** | `01-docker-build.png` |
| 2 | Unitarias y contrato Rust offline (`--network none`) | Fase 1 (`21d3edb`, inalterado en `167c120`) | `bash scripts/ark/docker-e2e.sh unit` | `0` | **PASS** (`lib`: 11/11, `main`: 1/1, `adapter_contract`: 5/5, `adapter_arkd_read`: 1 ignored) | `02-unit-rust-offline.png` |
| 3 | Regresión Bash bootstrap + escaneo histórico de secretos en contenedor fijado | **Fase 2 (`167c120`)** | `bash scripts/ark/docker-ci-checks.sh all` *(sin Node/jq/cargo en `PATH`)* | `0` | **PASS** (`PASS` regresión + `findings: 0` en **176** archivos / **353** blobs; paridad 100% con host) | `10-docker-ci-checks-encapsulated.png` *(histórica `21d3edb`: `03-bash-regression-and-secrets.png`)* |
| 4 | Arranque desde cero, salud y `chain=regtest` | Fase 1 (`21d3edb`) | `bash scripts/ark/docker-e2e.sh start && status` | `0` | **PASS** (`regtest`, génesis exacto, altura 102, `arkd v0.9.25`, `21.00000000` BTC) | `04-start-health-regtest.png` |
| 5 | Wallets persistentes A y B (normales, separadas del fixture) | Fase 1 (`21d3edb`) | `bash scripts/ark/docker-e2e.sh wallets` | `0` | **PASS** (`tark1`/`bcrt1p` verificadas, saldo 0, `restore` OK) | `05-wallets-ab.png` |
| 6 | Matriz E2E en vivo (10 etapas live + 2 skip) | Fase 1 (`21d3edb`) | `bash scripts/ark/docker-e2e.sh e2e` | `0` | **PASS** (10/10 live `PASSED`, 2 `SKIPPED`) | `06-e2e-live-matrix.png`, `07-e2e-txids-evidence.png` |
| 7 | Integración real SDK → `arkd` (`adapter_arkd_read`) | Fase 1 (`21d3edb`) | `bash scripts/ark/docker-e2e.sh integration` | `0` | **PASS** (`1 passed, 0 failed`, `dust=330`, Alice `125,000` sats, 3 VTXOs) | `08-integration-and-negative-guard.png` |
| 8 | Negativo esperado: re-ejecución sobre fixture reclamado | Fase 1 (`21d3edb`) | `bash scripts/ark/docker-e2e.sh e2e` (2.ª vez) | `1` *(esperado)* | **PASS (negativo esperado)** (`fixture already claimed`) | `08-integration-and-negative-guard.png` |
| 9 | Persistencia tras parada y reinicio completo del stack | Fase 1 (`21d3edb`) | `bash scripts/ark/docker-e2e.sh restart-check` | `0` | **PASS** (6/6 invariantes `true`, 10 IDs y 8 volúmenes idénticos, altura 106) | `09-restart-persistence-and-stop.png` |
| 10 | Parada final no destructiva | Fase 1 (`21d3edb`) | `bash scripts/ark/docker-e2e.sh stop` | `0` | **PASS** (`0` activos, `10` en `Exited`, `8` volúmenes intactos) | `09-restart-persistence-and-stop.png` |
| 11 | Invariancia de flujo, reconciliación de escaneo y chequeo Docker Engine nativo | **Fase 2 (`167c120`)** | `git diff --stat 21d3edb..HEAD -- ark/ ...` + chequeo motor | `0` | **PASS** (diff vacío, reconciliación exacta, Docker Engine+Compose v2: **`NO VALIDADO`**) | `11-reconciliation-diff-and-engine-check.png` |

### 3.4 Reconciliación exacta de conteos `secrets:check` por revisión Git

| Revisión Git (`HEAD`) | Alcance / rama | `indexedFiles` | `historicalBlobs` | `findings` | Modo y alcance de `rev-list --all` |
| --- | --- | ---: | ---: | ---: | --- |
| `21d3edb` | Fase 1 (`ark-docker-e2e`, previo a Commit 3) | **162** | **336** | **0** | Host (histórico reemplazado — `03-bash-regression-and-secrets.png`) |
| `5a9976b` | Commit 3 (`ark-docker-e2e`, evidencia inicial) | **173** | **348** | **0** | Contenedor == host (`+11` índice / `+12` blobs — `11-reconciliation-diff-and-engine-check.png`) |
| `167c120` | Fase 2 (`ark-docker-e2e`, encapsulación CI) | **176** | **353** | **0** | Contenedor sin Node (`+3` índice / `+5` blobs — `10-docker-ci-checks-encapsulated.png`) |
| `e52b3aa` | Commit 5 (`ark-docker-e2e`, docs/PNG/PDF) | **178** | **358** | **0** | Contenedor (`+2` índice / `+5` blobs sobre `167c120`) |
| `62eca45` | Fase 3 (`tmp/pr-61-candidate` final, sin `#63`/`#64`) | **160** | **599** | **0** | Contenedor fijado (repositorio multi-worktree con refs `main`/`pr-68`/ramas `tmp/*` en `rev-list --all`) |
| `ba319b3` | Fase 3 (`tmp/pr-63-candidate` final, con `#63`) | **166** | **599** | **0** | Contenedor fijado (`+6` archivos de `#63` en índice respecto a `#61`, `0` hallazgos) |
| Commit final `#64` | Fase 3 (`tmp/pr-64-candidate`, docs/PNG/PDF sobre `3f646c0`) | *Verificado post-commit* | *Verificado post-commit* | **0** | Contenedor fijado (`bash scripts/ark/docker-ci-checks.sh all`) |

---

## 4. Transacciones, VTXOs, Alturas, Balances y Fees Registrados

### 4.1 Corrida en vivo Fase 3 sobre el SHA final de código (`ba319b35423a16ac2bf07b8123be1f1e6806bcfc`)

**Instancia aislada:** `ARK_E2E_INSTANCE=dist` (`swap-engine-ark-docker-e2e-dist`, red interna `swap_engine_ark_e2e_dist_net`, 0 puertos host)  
**Génesis regtest verificado:** `0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206`  
**Signer del operador (`arkd v0.9.25`):** `0381c2efcf80108040145cf696f66656de1b691ed0ab046a2f3583d48fb5cf4474` (`dust: 330` sats, intent fees: `0.0`)

| Operación | TXID | Altura Core / Block Hash | VTXO / Outpoint resultante | Balance antes → después | Fee cadena / Fee usuario |
| --- | --- | --- | --- | --- | --- |
| Fondeo boarding Alice | `974efb951b29cf1396130c65627690dd1bd31fa3082d94c731f7d7019384a73f` | `103` / `31dafcee9b4ea385ef9f6c8eeb0ed91ee9e60b8fa21ddf7a9734d1cf28427473` | UTXO `:0` (`200,000` sats) a `bcrt1p6qa6u6rgckuvn2s7lk3vysgvyjsmnr0hmq6cv2uwckr6shn8hnpshnz5e4` | Miner → boarding `200,000` sats | `165` sats cadena / N/A |
| Boarding commitment | `6d3012ae26176a32a04ba3aa9f6e0a03a6e20498811251e3bb472be94079dcf9` | `104` / `5d0e59e91e5c3decdf854af71f868f453ca8be7eff1ea290dabfa30b996dd93c` | `c5767cb1f71474eea6344dd4d7c3a10cbe5360e5edb697bde32571df2195fd49:0` (`200,000` sats, `batch_leaf`) | Alice Ark: `0 → 200,000` sats | `262` sats cadena / `0` sats usuario |
| Transferencia Ark A → B | `574d4f30bedd50e5b1f6ed9b80396d1f021b0a7c2df5af586aed755d45b315cb` | Off-chain (preconfirmación finalizada; ancestro en `104`) | Bob `:0` (`75,000` sats), Alice cambio `:1` (`125,000` sats) | Alice `200,000 → 125,000`; Bob `0 → 75,000` | N/A / `0` sats usuario |
| Offboarding cooperativo Bob (VTXO apto) | `7985fd87a629eca97b7abb2932023ecd5a5df0599955b9c6f97109ca4c297c3f` | `105` / `66134a5c45b74ab6f4e7ba48bfd03680525da6607e22782223530eb41fcb3918` | On-chain `:2` (`30,000` sats a `bcrt1p8wyvtg57tr9sq6mefx7j3pnk6fenldagkz2qe0zaykvfc8xw5nkqk95scr`), cambio Ark `23abcacaa5b658f04c157d4b2d9a3f6010376cc46ee1c0fbc557320b245f420f:0` (`45,000` sats) | Bob Ark `75,000 → 45,000`; Core `scantxoutset`: `0 → 30,000` sats | `241` sats cadena / `0` sats usuario |
| Renovación VTXO expirado Alice | `349adeab4cdcd4348d9504190f1f5ca6c9505fd079c17759090fbf9af4f2d195` | `106` / `3a77c32859cf494bcfe1c1dca796980da8f851207cfce3a6d1275ba045a6bbff` | `5620327fe554cb5b39d1e150314efb14777942e339ca21f08082a47f42f65af4:0` (`125,000` sats, `batch_leaf`) | Alice Ark: `125,000 → 125,000` sats | `198` sats cadena / `0` sats usuario |

- **Negativos P2 en vivo verificados sobre `ba319b35`:** `offboard-coop` sobre el VTXO consumido de Bob (`574d4f30...:0`) y sobre el VTXO expirado/recuperable de Bob (`23abcaca...:0`) rechazados antes de mutar con `ArkInputNotSpendable` (`exit 1`).
- **Integración real `adapter_arkd_read`:** `1 passed, 0 failed` (`arkd v0.9.25: dust=330 sats, Alice total=125000 sats, 3 VTXOs`, renewal `5620327fe554cb5b39d1e150314efb14777942e339ca21f08082a47f42f65af4:0`).
- **Persistencia `restart.json` (`ba319b35`):** altura `106` / tip `3a77c32859cf494bcfe1c1dca796980da8f851207cfce3a6d1275ba045a6bbff`, operador `20.99798639` / `0.00000660` BTC, wallets A/B normales sin cambios (`0` sats), fixture E2E Alice `125,000` sats (3 VTXOs) / Bob `45,000` sats (2 VTXOs), 10/10 container IDs (`ark_e2e_dist_*`) y 8/8 volúmenes (`swap_engine_ark_e2e_dist_*`) idénticos.
- **Validación P1 fail-closed sobre artefactos vivos de `ba319b35`:** `docker-ci-checks.sh validate-e2e-evidence` (sin `node`/`jq`/`cargo` en host) → `status: PASSED`, 6/6 JSON aprobados.

### 4.2 Corrida histórica Fase 1 (`21d3edb`, preservada íntegra con capturas `01`–`09.png`)

**Génesis regtest verificado:** `0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206`  
**Signer del operador (`arkd v0.9.25`):** `0277c640043d58d7d4f801f04afb502e15741878634d17a4b27c1d366ad19dbdca` (`dust: 330` sats, intent fees: `0.0`)

| Operación | TXID | Altura Core / Block Hash | VTXO / Outpoint resultante | Balance antes → después | Fee cadena / Fee usuario |
| --- | --- | --- | --- | --- | --- |
| Fondeo boarding Alice | `1dfa91a6b9ba60bccb88ad2ac8d41e58db500b011965254def865be2a04b22f9` | `103` / `5e3c35158fd86d594422c480f46b6e45556812f1b0548a30f0ad699d7c2b7db5` | UTXO `:0` (`200,000` sats) a `bcrt1phytn55lx96wufjw6auckrh5dz6r0ua3sadqnu5sn0m5t2ntu68uqg8ccpz` | Miner → boarding `200,000` sats | `165` sats cadena / N/A |
| Boarding commitment | `87d070e3ac5a4aa8ba01366684260f54b19cb93e71c8ecd56769e6963bf4161e` | `104` / `48fdc27805cc907312f3ad29e0749a7b34c4aff8d7445661cf61cc6e1b53aef3` | `6e23fd4a102541afd92a18ee6fed16f94da1a5b9a1742ddd3db90e77b37f7b5b:0` (`200,000` sats, `batch_leaf`) | Alice Ark: `0 → 200,000` sats | `262` sats cadena / `0` sats usuario |
| Transferencia Ark A → B | `66f16cf28a3dfc8fbf41f1325231fc4cb97fa4b847cf9887cb6e884351ac6d01` | Off-chain (preconfirmación finalizada; ancestro en `104`) | Bob `:0` (`75,000` sats), Alice cambio `:1` (`125,000` sats) | Alice `200,000 → 125,000`; Bob `0 → 75,000` | N/A / `0` sats usuario |
| Offboarding cooperativo Bob | `c930b92013cb145b0fdf96ce65b681e7c311f210cd2b5262ce78d9c2c2be217d` | `105` / `4a393a5d14675b162e86e89d44914187560df743e5625e7c66eb207fb4ff889b` | On-chain `:2` (`30,000` sats a `bcrt1pv0dq2exrvfk4sz5xlax9dgul4gnfr3jknht3padnmmx5tvvmf97sk4muat`), cambio Ark `f45959dc5df8f63652ef4d997dca07b3fff6ed3373e44ce0dc007e49215db79b:0` (`45,000` sats) | Bob Ark `75,000 → 45,000`; Core `scantxoutset`: `0 → 30,000` sats | `241` sats cadena / `0` sats usuario |
| Renovación VTXO expirado Alice | `93342cf8c81604868672d16bf7cda35ecd2f63abc0d6a1ea023e14f5accdb793` | `106` / `313367985a44d6759506c3c00f888bc602ff3f0cb1a03ad9eb74b86cbf79f263` | `1db950fcc4cdda6f25fa6bddd023648083f24bfa5f749fda7c2f8c8400ead3da:0` (`125,000` sats, `batch_leaf`) | Alice Ark: `125,000 → 125,000` sats | `198` sats cadena / `0` sats usuario |

- **Persistencia histórica `restart.json` (`21d3edb`):** altura `106` / tip `313367985a44d6759506c3c00f888bc602ff3f0cb1a03ad9eb74b86cbf79f263`, operador `20.99798639` / `0.00000660` BTC, wallets A/B normales (`0` sats), fixture E2E Alice `125,000` sats (3 VTXOs) / Bob `45,000` sats (2 VTXOs), 10/10 container IDs (`ark_e2e_*`) y 8/8 volúmenes (`swap_engine_ark_e2e_*`) idénticos.

---

## 5. Límites y Exclusiones Declaradas

- **Alcance estricto del laboratorio Ark (NO es evidencia de swaps Ark↔Lightning):** estas pruebas validan únicamente el laboratorio aislado `ark-lab` en Bitcoin regtest. No cubren swaps Ark↔Lightning, swaps Lightning→onchain, el motor Node de `swap-engine`, rutas admin ni frontend web.
- **Salida unilateral (`unilateral_exit: SKIPPED`):** fuera de alcance, no implementada ni expuesta en `ark-lab` (requiere `submitpackage`, árboles/checkpoints, CPFP y espera CSV).
- **Timeout real en medio de mutación (`live_mutation_timeout: SKIPPED`):** cubierto únicamente mediante simulación unitaria sintética offline (`bounded_submission_timeout_is_uncertain` y `simulated_offboard_submission_timeout_is_uncertain`), no mediante retardo real en medio de una ronda.
- **Docker Engine + Docker Compose v2 nativos: `NO VALIDADO`.** Comprobación de solo lectura en el host (`11-reconciliation-diff-and-engine-check.png`): `dockerd` no está instalado, `/usr/libexec/docker/cli-plugins` no existe, `systemctl is-active docker` devuelve `inactive` y `/run/docker.sock` es symlink a `/run/podman/podman.sock`. Toda la validación local se ejecutó sobre `podman 4.3.1` + `podman-compose 1.6.0`.
- **GitHub Actions Ubuntu (`ubuntu-latest`): `NO VALIDADO`** en remoto — los workflows `.github/workflows/ark-lab-unit.yml` y `.github/workflows/ark-lab-e2e.yml` no se han despachado en GitHub Actions desde este worktree aislado (publicación reservada al coordinador).
- **Higiene de secretos y artefactos:** ningún secreto, mnemónico, clave privada, `compose.env` ni log bruto de servicio fue capturado ni incluido en el repositorio ni en el informe PDF.
