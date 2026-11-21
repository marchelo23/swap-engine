# Evidencia E2E Docker: Arkade Rust SDK en regtest (`Truja503/swap-engine`)

**Solo Bitcoin regtest — sin mainnet, sin fondos reales y sin servicios Core/LND compartidos.**

Informe técnico reproducible de la implementación y ejecución desde estado limpio del laboratorio Docker aislado para el SDK oficial [`arkade-os/rust-sdk` v0.12.1](https://github.com/arkade-os/rust-sdk/tree/v0.12.1) (`352ca21bcaa01d3ddb535b0ebfb20cd9b028c357`).

- **Informe PDF en español (con 9 capturas reales de terminal GUI):** [ark-docker-e2e-report-es.pdf](evidence/docker-e2e/ark-docker-e2e-report-es.pdf)
- **Directorio estable de capturas PNG reales:** `docs/ark/evidence/docker-e2e/screenshots/`
- **Guía reproducible del laboratorio Docker:** [docker-lab.md](docker-lab.md)

---

## 1. Trazabilidad Git, Entorno y Versiones

| Campo | Valor verificado |
| --- | --- |
| Repositorio / Worktree aislado | `Truja503/swap-engine` — `/home/chelo/orca/workspaces/swap-engine/ark-docker-e2e` (rama `ark-docker-e2e`) |
| Base de partida (`ark-regtest-46-54`) | `70723afc66e95ac0c31bdea74b2a143f8bec668b` |
| Commit 1 (destino PR `#61` / `#53` Docker/harness/CI) | `855ab01ded8bddbc2921aed583c36814fced0704` |
| Commit 2 (destino PR `#63` / `#54` restauración `f5742b0`) | `21d3edb06d7b9ec59130ba61632540fd0dac6dd7` (**SHA de código probado en vivo**) |
| Commit 3 (destino PR `#64` evidencia/PDF) | Solo documentación, PNGs saneados y PDF sobre `21d3edb` (`git diff 21d3edb..HEAD -- ark/ deploy/ scripts/ .github/` vacío) |
| Fecha de ejecución en vivo | `2026-11-21` (`12:12` – `12:25 -06:00`) |
| Sistema operativo host | `Linux 6.12.74+deb12-amd64 x86_64 GNU/Linux` (X11 `:0`, Qtile, `kitty` GUI real) |
| Motor de contenedores / Compose | `podman 4.3.1` (wrapper CLI `docker`) / `podman-compose 1.6.0` |
| Toolchain Rust en imagen `ark-sdk` | `rustc 1.97.1 (8bab26f4f 2026-07-14)` / `cargo 1.97.1 (c980f4866 2026-06-30)` (`rust:1.97.1-slim-bookworm`) |
| SDK Rust oficial fijado | `arkade-os/rust-sdk` v0.12.1 (`352ca21bcaa01d3ddb535b0ebfb20cd9b028c357`) |
| Stack de servicios fijados | Bitcoin Core `31.0`, `arkd`/`arkd-wallet`/`arkd-signer` `v0.9.25`, PostgreSQL `16`, NBXplorer `2.6.7`, Fulcrum `v2.1.1`, Mempool Backend (Esplora) `v3.3.1`, Redis `7-alpine` |
| Proyecto / Red / Volúmenes dedicados | Proyecto `swap-engine-ark-docker-e2e`, red privada `swap_engine_ark_e2e_net` (`internal: true`), 8 volúmenes activos (`swap_engine_ark_e2e_*`), 0 puertos publicados en host |

---

## 2. Inventario GitHub (`#56 → #64`) y Discrepancias Forenses

### 2.1 Cadena real de PRs abiertos en `Truja503/swap-engine`

Verificación ejecutada vía `gh pr list` / `gh pr view` (solo lectura; sin modificar ramas ni refs de PR):

| Orden real | PR | Estado | Rama (`head`) | SHA publicado | Título real (contenido Git) | Discrepancia detectada en cuerpo/metadatos |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | `#56` | OPEN | `ark/pr-47-architecture` | `224cf0d` | `[ARK][01] #47 - Architecture, compatibility and implementation plan` | Coherente (`1/9`, `Refs #47`). |
| 2 | `#59` | OPEN | `ark/pr-48-operator` | `1df4813` | `[ARK][02] #48 - Isolated Arkade regtest operator lifecycle` | **Cuerpo intercambiado con `#57`:** el cuerpo dice `4/9`, `Refs #50` (boarding), pero rama/commits/título son `#48`. |
| 3 | `#58` | OPEN | `ark/pr-49-wallets` | `e0b0ef5` | `[ARK][03] #49 - Persistent Arkade SDK wallets A/B` | Cuerpo dice "merge after `#57`" en vez de "after `#59`". |
| 4 | `#57` | OPEN | `ark/pr-50-boarding` | `56998d0` | `[ARK][04] #50 - Regtest BTC boarding into Ark VTXO` | **Cuerpo intercambiado con `#59`:** el cuerpo dice `2/9`, `Refs #48` (operator), pero rama/commits/título son `#50`. |
| 5 | `#60` | OPEN | `ark/pr-51-transfer` | `f075ee2` | `[ARK][05] #51 - Ark regtest transfer and recovery` | Cuerpo dice "merge after `#59`" en vez de "after `#57`". |
| 6 | `#62` | OPEN | `ark/pr-52-offboarding` | `1d4f1e0` | `[ARK][06] #52 - Cooperative Ark offboarding to Bitcoin Core (regtest)` | **Cuerpo intercambiado con `#61`:** el cuerpo dice `7/9`, `Refs #53` (harness/CI), pero rama/commits/título son `#52`. |
| 7 | `#61` | OPEN | `ark/pr-53-harness-ci` | `a907fc8` | `[ARK][07] #53 - Ark regtest harness, runbook and isolated CI` | **Cuerpo intercambiado con `#62`:** el cuerpo dice `6/9`, `Refs #52` (offboarding), pero rama/commits/título son `#53`. |
| 8 | `#63` | OPEN | `ark/pr-54-adapter-and-fixes` | `09960c8` | `[ARK][08] #54 - ArkAdapter contract, SDK read verification and review fixes` | **Regresión crítica:** el cuerpo afirma incluir `f5742b0`, pero `f5742b0` fue omitido al reescribir el stack; `test-bootstrap-funding.sh` falla con `exit 1` en `09960c8`. |
| 9 | `#64` | OPEN | `ark/pr-extra-security-validation` | `70723af` | `[ARK][EXTRA] Regtest validation evidence and security review` | Hereda la omisión de `f5742b0`; `docs/ark/security-review.md` replica la numeración intercambiada (`#57/#48`, `#59/#50`, `#61/#52`, `#62/#53`) y da por aplicadas defensas ausentes en `70723af` (`require_regtest()` en `lib.rs`, `test-bootstrap-funding.sh` en `--unit-only`). |

> **Nota sobre `main` remoto:** `Truja503/swap-engine` ya tiene fusionado PR `#68` en `main` (`578a81b`), mientras el stack Ark parte de `d5e88ef` (`PR #55`). No se tocó motor, Node CI ni `package.json`.

### 2.2 Comparativa forense: publicado `70723af` vs `f5742b0` vs `backup/ark-full-0f17582` (`0f17582`)

Evidencia verificada con `git log`, `git diff 70723af backup/ark-full-0f17582`, `git show --stat f5742b0` y ejecución real sobre `70723af`:

- **Ancestría:** `backup/ark-full-0f17582` (`0f17582`, 22 commits sobre `main`) contiene `f5742b0` (`Fix Ark regtest review blockers and recovery checks`) y todos los commits de hardening `ark(pr-48)`..`ark(pr-64)`. En el stack publicado `70723af` (21 commits), `f5742b0` **no es ancestro** (`merge-base` con `backup/ark-full-0f17582` es `224cf0d`).
- **Correcciones preservadas en `70723af`:**
  - Hardening de seguridad de `ark(pr-48)`..`ark(pr-64)` en `wallet_store.rs`, `offboard.rs`, `adapter.rs`, `ark-lab-e2e.yml`, `deploy/ark/.gitignore`, `ark/.gitignore`, `bootstrap-funding.sh` (validación numérica con `jq`), `test-bootstrap-funding.sh` (casos `zero_float` y `negative_balance`) y `main.rs` (`checked_fixture_root`).
  - Sin embargo, en `70723af`, `scripts/ark/bootstrap-funding.sh` quedó huérfano (no invocado por `bootstrap-regtest.sh`) y `bash scripts/ark/test-bootstrap-funding.sh` falló realmente con `exit 1` (`bootstrap-funding.sh: line 9: miner_history: command not found`).
- **Correcciones perdidas en `70723af` (16 archivos de `f5742b0` + 1 hunk de `4fee198`, TODOS preservados en `backup/ark-full-0f17582` y restaurados en esta rama):**

| Archivo | Qué se perdió en `70723af` (presente en `f5742b0` / `0f17582`) | Restaurado en |
| --- | --- | --- |
| `deploy/ark/docker-compose.regtest.yml` | Red bridge `host_access` (`swap_engine_ark_host_net`) requerida por Docker Engine para publicar puertos loopback. | Commit 2 (`21d3edb`) |
| `scripts/ark/common.sh` | `host_services`, `managed_services`, `assert_host_networks()`, `miner()`, `confirmed_utxo()`, `miner_history()`. | Commit 2 (`21d3edb`) |
| `scripts/ark/bootstrap-regtest.sh` | `assert_host_networks existing` e invocación de `bootstrap-funding.sh` con diario durable por slots `01..21`. | Commit 2 (`21d3edb`) |
| `scripts/ark/stop-regtest.sh` | Iteración sobre `managed_services` en parada. | Commit 2 (`21d3edb`) |
| `scripts/ark/test-regtest.sh` | Ejecución de `test-bootstrap-funding.sh` en `--unit-only`, `assert_host_networks all`, etapas `boarding_operator_outage` y `operator_restart` (verificación de saldos/VTXOs idénticos tras reinicio de `arkd`). | Commit 2 (`21d3edb`) |
| `scripts/ark/e2e-boarding.sh` | `assert_only_boarding_funding()`, `confirmed_utxo()`, prueba de caída `boarding_operator_outage`. | Commit 2 (`21d3edb`) |
| `scripts/ark/e2e-transfer.sh` | Descarte deliberado de acuse de `transfer-submit`, recuperación del TXID desde `pending`, `verify-spent` sin replay. | Commit 2 (`21d3edb`) |
| `scripts/ark/e2e-offboard.sh` | `confirmed_utxo()` y segundo `scantxoutset` midiendo delta real `0 -> 30000` sats. | Commit 2 (`21d3edb`) |
| `ark/ark-lab/src/lib.rs` | `RegtestBlockchain::require_regtest()` en `Board`/`SettleVtxo` (proveniente de `4fee198`, perdido en `56998d0`) y `Action::VerifySpent(OutPoint)`. | Commit 1 (`855ab01`) |
| `ark/ark-lab/src/main.rs` | Firma `VerifySpent` sin requerir `sats` (mantenido opcional oculto para compatibilidad). | Commit 1 (`855ab01`) |
| `ark/ark-lab/src/transfer.rs` | `verify_spent` estrictamente de solo lectura (`list_vtxos` + `spendable_offchain`) sin invocar `send_selection`. | Commit 1 (`855ab01`) |
| `ark/ark-lab/tests/adapter_contract.rs` | `reserved_inputs`, `original_ark_txids` y 6 casos negativos `ObservedTransfer` en recuperación incierta. | Commit 2 (`21d3edb`) |
| `ark/rust-toolchain.toml` | Toolchain fijado `channel = "1.97.1"` (revertido a `"stable"` en `70723af`). | Commit 1 (`855ab01`) |
| `.github/workflows/ark-lab-unit.yml` | Ejecución de `test-bootstrap-funding.sh` (actualizado ahora al flujo Dockerizado + guard condicional). | Commit 1 (`855ab01`) |
| `docs/ark/operator-regtest.md` | Documentación de migración de `host_access` y diario `data/ark/operator-funding/`. | Commit 2 (`21d3edb`) |
| `docs/ark/regtest-runbook.md` | Documentación de `boarding_operator_outage`, descarte de acuse, `verify-spent` solo lectura, `scantxoutset` y `operator_restart`. | Commit 2 (`21d3edb`) |

### 2.3 Aplicabilidad y destino de commits locales (verificada sin alterar refs de PR)

1. **Commit 1 (`855ab01`) → PR `#61` (`#53` harness/CI):** 12 de 13 archivos aplican limpiamente de forma directa sobre `a907fc8`. El único hunk que requiere contexto 3-way en `a907fc8` es `ark/ark-lab/src/lib.rs:107` porque PR `#63` extrajo `query_operator_info()`. **Dependencia con `#63`:** el laboratorio Docker y las etapas unitarias/E2E del CLI funcionan de forma autónoma sobre `#61`, pero la prueba de integración real `adapter_arkd_read`, las pruebas de contrato `adapter_contract` y `test-bootstrap-funding.sh` existen únicamente a partir de PR `#63` (`#54`); sin `#63`, `docker-e2e.sh e2e` marca `adapter_arkd_read` como `SKIPPED`.
2. **Commit 2 (`21d3edb`) → PR `#63` (`#54` adapter/fixes):** verificado `git apply --check` **100% limpio sin conflictos** directamente sobre `09960c8`.
3. **Commit 3 → PR `#64` (`[EXTRA]` evidencia/PDF):** solo añade/actualiza archivos bajo `docs/ark/`, aplicable limpiamente sobre `70723af`.

---

## 3. Resultados por Etapa (Ejecución Limpia sobre `21d3edb`)

| # | Etapa / Comprobación | Comando exacto | Exit code real | Estado | Captura real PNG |
| ---: | --- | --- | ---: | --- | --- |
| 1 | Build imagen SDK Rust (`--locked`, `rustfmt`, `clippy`) | `bash scripts/ark/docker-e2e.sh build` | `0` | **PASS** | `01-docker-build.png` |
| 2 | Unitarias y contrato Rust offline (`--network none`) | `bash scripts/ark/docker-e2e.sh unit` | `0` | **PASS** (`lib`: 11/11, `main`: 1/1, `adapter_contract`: 5/5, `adapter_arkd_read`: 1 ignored) | `02-unit-rust-offline.png` |
| 3 | Regresión Bash bootstrap + higiene de secretos | `bash scripts/ark/test-bootstrap-funding.sh && npm run secrets:check` | `0` | **PASS** (`PASS` + `findings: 0` en 162 archivos / 336 blobs) | `03-bash-regression-and-secrets.png` |
| 4 | Arranque desde cero, salud y `chain=regtest` | `bash scripts/ark/docker-e2e.sh start && bash scripts/ark/docker-e2e.sh status` | `0` | **PASS** (`regtest`, génesis exacto, altura 102, indexadores/DB/Redis/signer/`arkd v0.9.25` OK, `21.00000000` BTC) | `04-start-health-regtest.png` |
| 5 | Wallets persistentes A y B (normales, separadas del fixture) | `bash scripts/ark/docker-e2e.sh wallets` | `0` | **PASS** (`tark1`/`bcrt1p` verificadas, saldo 0, `restore` OK) | `05-wallets-ab.png` |
| 6 | Matriz E2E en vivo (10 etapas live + 2 skip) | `bash scripts/ark/docker-e2e.sh e2e` | `0` | **PASS** (10/10 live `PASSED`, 2 `SKIPPED`) | `06-e2e-live-matrix.png`, `07-e2e-txids-evidence.png` |
| 7 | Integración real SDK → `arkd` (`adapter_arkd_read`) | `bash scripts/ark/docker-e2e.sh integration` | `0` | **PASS** (`1 passed, 0 failed`, `dust=330`, Alice `125,000` sats, 3 VTXOs) | `08-integration-and-negative-guard.png` |
| 8 | Negativo esperado: re-ejecución sobre fixture reclamado | `bash scripts/ark/docker-e2e.sh e2e` (2.ª invocación) | `1` *(esperado)* | **PASS (negativo esperado)** (`fixture already claimed; inspect original state, never repeat funding`) | `08-integration-and-negative-guard.png` |
| 9 | Persistencia tras parada y reinicio completo del stack | `bash scripts/ark/docker-e2e.sh restart-check` | `0` | **PASS** (6/6 invariantes `true`, 10 container IDs y 8 volúmenes idénticos, altura 106) | `09-restart-persistence-and-stop.png` |
| 10 | Parada final no destructiva | `bash scripts/ark/docker-e2e.sh stop` | `0` | **PASS** (`0` contenedores activos, `10` preservados en `Exited`, `8` volúmenes intactos) | `09-restart-persistence-and-stop.png` |

### Desglose de sub-etapas de `matrix.json` y negativos esperados

- **PASS (en vivo, 10 etapas):** `boarding`, `boarding_operator_outage`, `transfer_and_client_restart`, `cooperative_offboard`, `stale_vtxo_and_renewal`, `adapter_arkd_read`, `operator_unavailable`, `operator_restart`, `rpc_unavailable`, `indexer_unavailable`.
- **Negativos esperados verificados (`exit 1` y error tipado antes de mutar):**
  - Preflight de fondeo inválido (dust `1` sat, exceso `2100000000000000` sats, dirección mainnet `1BitcoinEater...`) → rechazado.
  - Boarding con `ark_e2e_arkd` detenido → `ArkOperatorUnavailable`, 1 única TX de fondeo y UTXO intacto.
  - Transferencia con saldo insuficiente (`500,000` sats) → `ArkInvalidAmount`.
  - Offboarding a mainnet (`1BitcoinEater...`) → `ArkNetworkMismatch`; exceso (`100,000` sats) → `ArkInvalidAmount`; cambio sub-dust (`74,800` sats sobre `75,000`) → `ArkInvalidAmount`.
  - Transferencia con VTXO expirado → `ArkInputNotSpendable`.
  - Offboarding con `ark_e2e_arkd` detenido → `ArkOperatorUnavailable`; con `ark_e2e_mempool_api` detenido → `ArkIndexerUnavailable`; Core RPC con `ark_e2e_bitcoin` detenido → error esperado.
  - Re-reclamo del fixture one-shot → `exit 1` sin fondear ni minar.
- **SKIP explícitos (2):**
  - `unilateral_exit`: `SKIPPED` (no implementado ni expuesto en CLI; requiere `submitpackage`, árboles/checkpoints, CPFP y bloqueo CSV).
  - `live_mutation_timeout`: `SKIPPED` (cubierto únicamente mediante simulación unitaria offline `bounded_submission_timeout_is_uncertain` y `simulated_offboard_submission_timeout_is_uncertain`).

---

## 4. Transacciones, VTXOs, Alturas, Balances y Fees Registrados (`21d3edb`)

**Génesis regtest verificado:** `0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206`  
**Signer del operador (`arkd v0.9.25`):** `0277c640043d58d7d4f801f04afb502e15741878634d17a4b27c1d366ad19dbdca` (`dust: 330` sats, intent fees: `0.0`)

| Operación | TXID | Altura Core / Block Hash | VTXO / Outpoint resultante | Balance antes → después | Fee cadena / Fee usuario |
| --- | --- | --- | --- | --- | --- |
| Fondeo boarding Alice | `1dfa91a6b9ba60bccb88ad2ac8d41e58db500b011965254def865be2a04b22f9` | `103` / `5e3c35158fd86d594422c480f46b6e45556812f1b0548a30f0ad699d7c2b7db5` | UTXO `:0` (`200,000` sats) a `bcrt1phytn55lx96wufjw6auckrh5dz6r0ua3sadqnu5sn0m5t2ntu68uqg8ccpz` | Miner → boarding `200,000` sats | `165` sats cadena / N/A |
| Boarding commitment | `87d070e3ac5a4aa8ba01366684260f54b19cb93e71c8ecd56769e6963bf4161e` | `104` / `48fdc27805cc907312f3ad29e0749a7b34c4aff8d7445661cf61cc6e1b53aef3` | `6e23fd4a102541afd92a18ee6fed16f94da1a5b9a1742ddd3db90e77b37f7b5b:0` (`200,000` sats, `batch_leaf`) | Alice Ark: `0 → 200,000` sats | `262` sats cadena / `0` sats usuario |
| Transferencia Ark A → B | `66f16cf28a3dfc8fbf41f1325231fc4cb97fa4b847cf9887cb6e884351ac6d01` | Off-chain (preconfirmación finalizada; ancestro en `104`) | Bob `:0` (`75,000` sats), Alice cambio `:1` (`125,000` sats) | Alice `200,000 → 125,000`; Bob `0 → 75,000` | N/A / `0` sats usuario |
| Offboarding cooperativo Bob | `c930b92013cb145b0fdf96ce65b681e7c311f210cd2b5262ce78d9c2c2be217d` | `105` / `4a393a5d14675b162e86e89d44914187560df743e5625e7c66eb207fb4ff889b` | On-chain `:2` (`30,000` sats a `bcrt1pv0dq2exrvfk4sz5xlax9dgul4gnfr3jknht3padnmmx5tvvmf97sk4muat`), cambio Ark `f45959dc5df8f63652ef4d997dca07b3fff6ed3373e44ce0dc007e49215db79b:0` (`45,000` sats) | Bob Ark `75,000 → 45,000`; Core `scantxoutset`: `0 → 30,000` sats | `241` sats cadena / `0` sats usuario |
| Renovación VTXO expirado Alice | `93342cf8c81604868672d16bf7cda35ecd2f63abc0d6a1ea023e14f5accdb793` | `106` / `313367985a44d6759506c3c00f888bc602ff3f0cb1a03ad9eb74b86cbf79f263` | `1db950fcc4cdda6f25fa6bddd023648083f24bfa5f749fda7c2f8c8400ead3da:0` (`125,000` sats, `batch_leaf`) | Alice Ark: `125,000 → 125,000` sats | `198` sats cadena / `0` sats usuario |

### Persistencia tras reinicio completo del stack (`restart.json`)

- **Altura y tip Bitcoin Core:** `106` / `313367985a44d6759506c3c00f888bc602ff3f0cb1a03ad9eb74b86cbf79f263` (idénticos antes y después).
- **Operador (`mainAccount` / `connectorsAccount`):** `20.99798639` BTC / `0.00000660` BTC disponibles (idénticos).
- **Wallets A/B normales persistentes:**
  - Alice: `tark1qpmuvsqy84vd048cq8cy476s9c2hgxrcvdx30f9j0swnv6k3nk7u5erjct98xptgmzsmm0pppnl5tnsegpwerjvdzzg2a5dgd9mgn078theuwx`, boarding `bcrt1pve4kf65ghg2stxnnvy9rx9r37z0wdsf450g336mh7ndpcga89vmqjt7plg`, onchain `bcrt1pxtlzq0y94tzzt46exmacu2ycdfkugf837nqw7ed30atlzcgfzy8sqt505k` (`0` sats, `0` VTXOs).
  - Bob: `tark1qpmuvsqy84vd048cq8cy476s9c2hgxrcvdx30f9j0swnv6k3nk7u4e9xmdafkpy0chrx4l2wyrgajnygnhky7h8ejyh2mmr7lq6wp5k74l75rm`, boarding `bcrt1p8y3w8cy4rrmyldkdndqh5vq6d4wcg8jy2pdfre4gyaedhcurwnds7v0vnu`, onchain `bcrt1p468edm6lgadztxynl6huewqppcw74tcdf0zt9y7h27pg4k8edcgs2u4ue5` (`0` sats, `0` VTXOs).
- **Wallets fixture E2E:** Alice `125,000` sats (`recoverable`, 3 VTXOs), Bob `45,000` sats (`recoverable`, 2 VTXOs) — idénticos byte a byte.
- **Contenedores preservados sin recreación (10/10 IDs idénticos):** `ark_e2e_bitcoin=4142ab205459`, `ark_e2e_postgres=c5e72c3ce6fb`, `ark_e2e_sdk=d39387977f0e`, `ark_e2e_nbxplorer=b0e4688f990d`, `ark_e2e_fulcrum=cac76c546910`, `ark_e2e_mempool_api=be7184789f1a`, `ark_e2e_redis=0a9ee27d5099`, `ark_e2e_arkd_wallet=bb1d7208c316`, `ark_e2e_arkd_signer=a097f7908421`, `ark_e2e_arkd=af17748522a9`.
- **Volúmenes preservados (8/8):** `swap_engine_ark_e2e_{arkd_data,bitcoin_data,fulcrum_data,mempool_cache,nbxplorer_data,postgres_data,sdk_state,wallet_data}`.

---

## 5. Límites y Exclusiones Declaradas

- Sin pruebas de salida unilateral (`unilateral_exit: SKIPPED`) ni timeouts reales en medio de una mutación (`live_mutation_timeout: SKIPPED`, cubierto solo por simulación unitaria).
- Ejecución validada localmente en Podman `4.3.1` + `podman-compose 1.6.0`; los workflows `.github/workflows/ark-lab-unit.yml` y `.github/workflows/ark-lab-e2e.yml` no han sido despachados en GitHub Actions Ubuntu desde este worktree aislado (prohibición explícita de publicación/push).
- Ningún secreto, mnemónico, clave privada, `compose.env` ni log bruto de servicio fue capturado ni publicado.
