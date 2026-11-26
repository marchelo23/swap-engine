# Forward aislado con pagador fresco en regtest (análisis de admisibilidad, presupuestos y relevo en `127.0.0.1:3201/#forward`)

> **Estado de este documento (actualizado 2026-11-25):** el usuario autorizó implementar el perfil HTTP opt-in (Primer incremento, probado offline) y aprovisionar el entorno fresco `iso_rt_*` bajo los límites estrictos aquí asentados. El aprovisionamiento en vivo y el relevo de `:3201` quedan diferidos a la siguiente fase coordinada (nunca ejecutar aprovisionamiento dos veces ni tocar instancias, credenciales o Stores reales durante el primer incremento). No altera el diff de exclusión persistente ni realiza commits.

---

## 1. Veredicto de admisibilidad actual y mandato de entrega

### 1.1 Veredicto sobre perfiles y código existentes

La ejecución web en vivo está condicionada a que **ya exista** un perfil activo capaz de admitir una identidad financiera nueva de pagador sin excepción, sin alterar diarios/perfiles financieros previos y sin instalar wiring nuevo.

**Resultado del contraste en código: NO existe ningún perfil admisible.** No se provisiona, financia, activa ni modifica ningún servicio en vivo, ni se instala wiring ni se ejecuta prueba real sin completar las fases y autorizaciones descritas abajo.

| Entrada / perfil | Qué hace en código | Por qué NO admite pagador fresco / ejecución web |
| --- | --- | --- |
| `src/main.ts` (`startApplication`) | Carga `config(env)`, ejecuta `attestStartup(...)` (`src/environment/StartupAttestation.ts`), fija `DATA_DIR/.environment.json` con `assertStateScope(...)` (`src/environment/StateScope.ts:30-69`), abre `Store.open(c.directory)` (`src/main.ts:193`) y monta `createApi(..., { ... })` (`src/main.ts:206-210`). | **No instala `forward`** en `createApi`. Aunque `src/config.ts:280` parsea `FORWARD_SWAP_ENABLED`, `src/main.ts` no lo lee ni construye `Store.openForForward`, `CoreLndForwardPorts`, `HttpsLndPaymentTransport` ni `ForwardAdmission`. Los únicos modos CLI aceptados (`src/main.ts:74-96`) son `--guest-regtest`, `--owned-regtest` y `--controlled-reverse`. Sin `forward` en `createApi` (`src/api/server.ts:65-72, 224-230`), `GET /v1/forward/availability` devuelve `200 { executionAvailable: false }` y `/v1/forward*` devuelve `503 FORWARD_EXECUTION_UNAVAILABLE`. |
| `scripts/serve-unified-regtest.ts` + `scripts/unified-regtest-balances.ts` | Proxy HTTP loopback en `UNIFIED_BROWSER_ORIGIN` que enruta `/v1/guest/*` a `UNIFIED_GUEST_ORIGIN` y el resto a `UNIFIED_ADMIN_ORIGIN`, interceptando `GET /v1/operations/balances` (`scripts/serve-unified-regtest.ts:48-73`). | No abre `Store` ni monta `/v1/forward*`; delega en un upstream `ui-only`. Además `createRegtestBalanceExtension` (`scripts/unified-regtest-balances.ts:15-17`) exige `c.spendPolicy === 'disabled'`. |
| `src/api/operatorServer.ts`, `src/api/serveOwnedReverse.ts`, `src/api/controlledExecution.ts` | Gateways privados de operador para swaps inversos (`OwnedReverseApi`, `ControlledExecution`, `ReverseRecovery`). | No montan `/v1/forward*` ni `ForwardAdmission`; abren `Store.open(...)` sin lease por pagador. |
| `scripts/verify-forward-isolated.ts` (`--spend-isolated-regtest`) | Único punto que instancia `Store.openForForward`, `CoreLndForwardPorts` y `ForwardAdmission`. | Fixture CLI fuera de HTTP fijado en código a `swap-engine-iso-regtest`, `iso_rt_bitcoin` (`127.0.0.1:48443`, wallet `iso-core-lab`), `iso_rt_lnd_provider` (`127.0.0.1:48080`) como pagador, `iso_rt_lnd_alice` como receptor, estado volátil en `/tmp/opencode/forward-regtest-state` (`tmpfs`) y propietarios `'owner-a'`/`'owner-b'`. |
| `scripts/prepare-forward-consolidation.ts` (`src/persistence/PrepareForwardConsolidation.ts`) | Herramienta offline de consolidación en tres Stores. | Fijada a `target: 'admin-regtest-3201'` y `container: 'iso_rt_lnd_provider'`; no sirve HTTP ni ejecuta pagos. |
| Previews `:3200`, `:3201` (`ui-only`) y `deploy/` | `:3200` y `:3201` operan en solo lectura (`SPEND_POLICY=disabled`, `ui-only`, sin `router.macaroon`). `deploy/isolated-regtest/bootstrap.mjs` fija `SPEND_POLICY=disabled` y `FORWARD_SWAP_ENABLED=false`. | Reutilizar cualquier `DATA_DIR` previo falla en cerrado: `assertStateScope` (`src/environment/StateScope.ts:14-47`) rechaza con `STATE_SCOPE_MISMATCH` si cambia wallet, origen o `payerNode`, y `ForwardPayerRegistry` (`src/persistence/ForwardPayerRegistry.ts:163-306`) vincula `1:1` cada `payerNode` a un único `storeId` + `realpath` + `dev:ino` (`FORWARD_STATE_PAYER_MISMATCH` / `FORWARD_CANONICAL_STORE_MISMATCH`). |

### 1.2 Mandato de entrega y separación entre identidad web e identidad financiera

1. **Destino único de entrega:**
   - URL final exigida por el usuario: **`http://127.0.0.1:3201/#forward`** (`PORT=3201`, `AUTH_ORIGIN=http://127.0.0.1:3201`).
   - Deployment y principal web único exigido: **`admin-regtest-3201`** y su **UUID `ADMIN` autorizado verificado existente**.
   - **Prohibido** proponer como entrega un cambio de origen, otro puerto permanente, un nuevo perfil de navegador Orca o un principal `ADMIN` nuevo como alternativa.
2. **Separación estricta: identidad web autorizada existente vs identidad financiera nueva:**
   - **Identidad web autorizada existente (conservada):** origen `http://127.0.0.1:3201`, `DEPLOYMENT_ID=admin-regtest-3201`, `AUTH_STORE_PATH` propio de `:3201` y el UUID v4 canónico en minúsculas del `ADMIN` autorizado verificado. Al efectuar el relevo es obligatorio **reautenticar** en `http://127.0.0.1:3201` (`Sessions` en `src/auth/session.ts:36-158` mantiene sesiones en memoria).
   - **Identidad financiera nueva (totalmente aislada):** nuevo `DATA_DIR` durable fuera de `tmpfs`, nueva wallet Core exclusiva, nuevo LND pagador fresco (keygen nuevo sin restaurar seed), nuevo LND receptor fresco, nuevo canal directo confirmado, nuevas rutas de credenciales (`router.macaroon`, `readonly.macaroon`, `tls.cert`, cookie Core) y nuevo registro `1:1` en `ForwardPayerRegistry`.
   - **Aislamiento de secretos, cookies y Stores:** **jamás** compartir cookies de sesión, `AUTH_STORE_PATH`, secretos ni Stores financieros entre `:3200`, el antiguo preview `ui-only` de `:3201`, los históricos A/B, `iso_rt_lnd_provider`/`iso_rt_lnd_alice` o `ark_lab_*`. El Store financiero anterior de `:3201` permanece intacto y separado; el nuevo `admin-regtest-3201` con forward apunta a un `DATA_DIR` financiero **nuevo y vacío**.
3. **Puerto temporal privado, relevo coordinado y rollback exacto:**
   - **Puerto temporal distinto:** sólo permitido para **validaciones privadas previas al relevo** (p. ej. pruebas automatizadas/privadas de preflight, exclusión de locks y recuperación antes de tocar `:3201`), **nunca como entrega** ni URL para el usuario.
   - **Relevo coordinado:** una vez superados todos los controles y autorizaciones, se releva **únicamente el preview `ui-only` `:3201`** (sin detener ni alterar `:3200`).
   - **Rollback exacto:** ante cualquier fallo o aborto, se revierte **exactamente al preview `ui-only` `:3201`** (`SPEND_POLICY=disabled`, `FORWARD_SWAP_ENABLED=false`, sin `router.macaroon` ni puertos de escritura, manteniendo intacto `:3200` y preservando íntegro el nuevo `DATA_DIR` financiero).

---

## 2. Separación estricta de fases: Comité offline → Aprovisionamiento aprobado → Fijación post-keygen

> **Regla de autoridad:** toda autorización (presupuestos, aprovisionamiento en vivo, relevo de `:3201` y corrida en regtest) corresponde **exclusivamente al usuario** por escrito. **Prohibida cualquier autoaprobación por Astra** o por cualquier agente.

### 2.1 Fase A — Comité offline (sin aprovisionar nodos, sin preflight de nodos, sin tocar `:3201`)

En esta fase no existen todavía los nodos nuevos ni el canal, por lo que **no** se ejecuta preflight de nodos aún.

1. **Revisión e integración del gate de exclusión (sin alterarlo aquí):** aprobar el diff de exclusión persistente (`Store.openForForward`, `ForwardPayerRegistry`, `StrictJson`, `ForwardAdmission`, `ForwardExecutor`, `createApi`, `scripts/verify-forward-isolated.ts`) sin modificarlo durante esta revisión.
2. **Diseño e implementación aprobada del wiring HTTP forward y estado web terminal (fuera de esta tarea):**
   - Añadir en `src/main.ts` un modo explícito (p. ej. `--forward-regtest --policy-path <abs> --policy-sha256 <64-hex>`) que exija:
     - `APP_ENV=regtest`, `SPEND_POLICY=regtest-only`, `FORWARD_SWAP_ENABLED=true`, `REVERSE_SWAP_ENABLED=false`, `GUEST_SWAP_ENABLED=false`, `ENABLE_LIVE_SWAPS=false`, `REGTEST_AUTO_MINING=false`, `MINING_POLICY=disabled`, `ENABLE_READ_ONLY_RECOVERY=false`, `ARK_ENABLED=false`, `ARK_EXECUTION_ENABLED=false`, `LIQUID_ENABLED=false`, `LIQUID_EXECUTION_ENABLED=false` (y devuelva `503` sin mutar `state.json` en `POST /v1/quotes`, `POST /v1/ark/quotes` y demás mutaciones ajenas a `/v1/forward*`, conservando intactos otros perfiles).
     - `attestStartup` + `assertStateScope` + `assertOperatorBinding` vinculando `DEPLOYMENT_ID=admin-regtest-3201`, `AUTH_ORIGIN=http://127.0.0.1:3201`, `AUTH_STORE_PATH` de `:3201`, la nueva wallet Core exclusiva y las credenciales/nodos nuevos.
     - Apertura exclusiva mediante `Store.openForForward(c.directory, policy.payerNode)` (nunca `Store.open`), `CoreLndForwardPorts`, `HttpsLndPaymentTransport` y `ForwardAdmission` compartiendo el mismo `Store` canónico entregado a `createApi(..., { forward: { ownerId: policy.ownerId, admission } })` (`src/api/server.ts:65-72`).
   - Corregir `src/web/api.ts:265` para incluir `'FAILED_INSUFFICIENT_BALANCE'` en `forwardStatus.shape.state` (actualmente omite ese estado terminal aunque `src/web/forward.ts:74` ya lo maneja).
3. **Verificación offline automatizada:** ejecutar `npm run build`, `npm test` y `npm run secrets:check` tras los cambios de código pertinentes.
4. **Acreditación del principal web y almacenamiento durable:**
   - Verificar de forma de sólo lectura el UUID v4 canónico en minúsculas del `ADMIN` autorizado existente en el `AUTH_STORE_PATH` propio de `admin-regtest-3201` (sin leer ni compartir el de `:3200`).
   - Verificar mediante `df -T` / `findmnt` que las rutas destino de `DATA_DIR`, del registro `~/.local/share/lqwd-swap-engine/forward-payers/` y de los futuros volúmenes de nodos están en disco local persistente (**fuera de `tmpfs`**, jamás `/tmp`), pertenecen al mismo UID Linux y cumplen `0700`/`0600` sin symlinks.
   - Fijar la convención de nombres nuevos con prefijo **`iso_rt_*`** (ver sección 2.2), sin colisionar ni tocar ningún recurso `iso_rt_*` previo.
5. **Autorización explícita del usuario:** el usuario aprueba por escrito:
   - La topología nueva `iso_rt_*` y el uso exclusivo del destino `127.0.0.1:3201/#forward` (`admin-regtest-3201`).
   - Los presupuestos concretos e inequívocos (sección 3).
   - El inicio de la Fase B (aprovisionamiento).

### 2.2 Fase B — Aprovisionamiento aprobado (nodos nuevos `iso_rt_*`, faucet acotado, canal nuevo)

Sólo tras autorización escrita del usuario para la Fase B:

1. **Convención de nombres nuevos `iso_rt_*` (sin tocar antiguos):**
   - Quedan **intocables**: `iso_rt_bitcoin`, `iso_rt_lnd_provider`, `iso_rt_lnd_alice`, `iso-core-lab`, `iso_rt_postgres`, `iso_rt_redis`, `iso_rt_nbxplorer`, `iso_rt_fulcrum`, `iso_rt_mempool_api`, `iso_rt_arkd*`, `iso_rt_elements`, sus volúmenes/redes, `:3200`, los históricos A/B y el viejo `DATA_DIR` de `:3201`.
   - Todos los recursos nuevos mantienen prefijo `iso_rt_*` y nombres disjuntos, por ejemplo:
     - Contenedores/servicios nuevos: `iso_rt_lnd_fwd_payer`, `iso_rt_lnd_fwd_payee` (y, si el usuario aprueba un Core separado en lugar de una wallet aislada dentro de `iso_rt_bitcoin`, `iso_rt_bitcoin_fwd` con su propia red `iso_rt_fwd_net` y volumen `iso_rt_bitcoin_fwd_data`).
     - Volúmenes/directorios persistentes fuera de `tmpfs` (`0700`, p. ej. bajo `~/.local/share/iso_rt_fwd_3201/`): `iso_rt_lnd_fwd_payer`, `iso_rt_lnd_fwd_payee`, `iso_rt_fwd_state` (`DATA_DIR` nuevo), `iso_rt_fwd_secrets`, `iso_rt_fwd_profile`.
     - Wallet Core exclusiva nueva: `iso_rt_core_fwd` (nunca `iso-core-lab`), con `private_keys_enabled: true`, descriptor wallet vacía, saldo inicial `0`.
     - Puertos loopback nuevos en `127.0.0.1` distintos de `:3200`, `:3201`, `:40009–49736` y del puerto temporal de validación.
2. **Verificación de Bitcoin Core regtest y wallet exclusiva:**
   - `getblockchaininfo`: `chain === "regtest"`, `initialblockdownload === false`, `blocks === headers`.
   - `getblockhash 0`: exactamente `0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206`.
   - `getzmqnotifications`: `pubrawblock` y `pubrawtx` activos.
   - `createwallet "iso_rt_core_fwd" false false "" false true true`, confirmando vía `listwallets` y `getwalletinfo` que está vacía (`balance === 0`, `private_keys_enabled === true`).
3. **LND pagador y receptor frescos (keygen nuevo, sin restaurar seed):**
   - Levantar `iso_rt_lnd_fwd_payer` e `iso_rt_lnd_fwd_payee` (`lnd:v0.20.8-beta` para coincidir con `CoreLndForwardPorts.ts:45` y `preflight.ts:67`, o build más reciente que emita `wallet_synced: true`).
   - Generar contraseñas nuevas (`0600`) e inicializar ambos con `/v1/genseed` + `/v1/initwallet`. **Prohibido** restaurar `cipher_seed_mnemonic`, `channel.backup`, macaroons o `lnd.db` anteriores.
   - Esperar `SERVER_ACTIVE` y `synced_to_chain === true` coincidiendo con el tip de Core.
4. **Fondeo acotado desde faucet maduro (sin coinbases en nodos ni en depósitos):**
   - Aplicar estrictamente la separación faucet-maduro vs asignaciones acotadas de la sección 3.2:
     - Enviar **`350,000` sats** (`coinbase: false`) desde la wallet faucet madura a `/v1/newaddress?type=WITNESS_PUBKEY_HASH` de `iso_rt_lnd_fwd_payer`.
     - Enviar **`50,000` sats** (`coinbase: false`) desde la wallet faucet madura a una dirección de prueba/depositante (en wallet de ensayo separada o UTXO etiquetado fuera de direcciones reservadas `#forward`).
     - **`0` sats** on-chain a `iso_rt_lnd_fwd_payee`.
     - Minar confirmaciones en Core dirigiendo la recompensa coinbase **exclusivamente** a la wallet minera/faucet.
5. **Peer nuevo y canal directo único (`>= 6` confirmaciones):**
   - Conectar `iso_rt_lnd_fwd_payer` con `iso_rt_lnd_fwd_payee` (`POST /v1/peers`, `perm: true`).
   - Abrir 1 único canal directo (`local_funding_amount: "300000"`, `push_sat: "0"`, `private: false`, `zero_conf: false`).
   - Minar en Core (hacia la wallet minera/faucet) hasta alcanzar **`confirmations >= 6`** en el outpoint de funding del canal, y comprobar `gettxout <funding_txid> <vout> true` (`confirmations >= 6`, `coinbase: false`, `bestblock === tip`, `scriptPubKey.hex` con prefijo `0020...` según `CoreLndForwardPorts.ts:97-100`).

### 2.3 Fase C — Fijación post-keygen, journal durable previo al primer gasto y preflight operativo

Sólo después de completar la Fase B:

1. **Captura post-keygen y post-canal:**
   - Leer `newPayerPubkey` en `iso_rt_lnd_fwd_payer` (`/v1/getinfo`) y `newPayeePubkey` en `iso_rt_lnd_fwd_payee` (`/v1/getinfo`), y `channelId` (`scid`) + `channel_point` en `/v1/channels`.
   - Comprobar: `newPayerPubkey !== newPayeePubkey`, ambos distintos de `iso_rt_lnd_provider` / `iso_rt_lnd_alice`, sin archivos en `~/.local/share/lqwd-swap-engine/forward-payers/{locks,bindings}` para `newPayerPubkey`, y `listpayments` vacío en `iso_rt_lnd_fwd_payer`.
2. **Journal durable fuera de `tmpfs` ANTES de usar LND para el primer gasto:**
   - Crear `DATA_DIR` nuevo y vacío (`iso_rt_fwd_state`, `0700`, verificado fuera de `tmpfs`).
   - Mantener el macaroon Router de `iso_rt_lnd_fwd_payer` inaccesible hasta que la CLI offline auditada (`scripts/provision-forward-regtest.ts --policy-path <abs> --policy-sha256 <64-hex>`, que invoca `Store.provisionFreshForward(DATA_DIR, newPayerPubkey, forwardStateScope(policy))`) haya inicializado de forma durable, verificando almacenamiento persistente en `DATA_DIR` y `~/.local/share/lqwd-swap-engine/forward-payers/`, antes de arrancar `Store.openForForward`:
     - Horneado de mínimo privilegio real LND (sin usar `admin.macaroon`, `router.macaroon` genérico con `offchain:write` ni `readonly.macaroon` por defecto con `invoices:read`/`macaroon:read`/`signer:read`): `payerRouterMacaroonPath` exige permisos URI reales (`entity="uri"`, `actions=["/routerrpc.Router/SendPaymentV2", "/routerrpc.Router/TrackPaymentV2"]`, sin caveats ni métodos extra); `payerReadMacaroonPath` y `payeeReadMacaroonPath` exigen los URIs mínimos de lectura (`GetInfo`, `ListChannels`, `WalletBalance`, y además `ListPayments`/`DecodePayReq` en pagador; opcional `/lnrpc.State/GetState`) o la allowlist cerrada `info:read offchain:read onchain:read`.
     - `<newPayerPubkey>.lock` (`O_CREAT|O_EXCL|O_NOFOLLOW`, `0600`) y `DATA_DIR/engine.lock` durante la provisión (liberándolos limpiamente al concluir).
     - `DATA_DIR/.environment.json` (`assertStateScope`, `version: 2`, `deploymentId: "admin-regtest-3201"`, `wallet: "iso_rt_core_fwd"`, `providerNode: newPayerPubkey`, `payerNode: newPayeePubkey`, campos `liquid*: null`).
     - `DATA_DIR/.forward-payer.json` y `bindings/<newPayerPubkey>.json` vinculando `1:1` `newPayerPubkey`, `storeId`, `realpath(DATA_DIR)`, `dev`, `ino` y `uid`.
     - `DATA_DIR/state.json` inicial con `forwardPayments` y `forwardAdmissions` ausentes/vacíos antes de admitir la primera factura.
3. **Fijación del perfil SHA-256 final (`--policy-sha256`):**
   - Escribir el archivo de política inmutable (`0600`, fuera del repo y fuera de `DATA_DIR`) con:
     - `deploymentId: "admin-regtest-3201"`, `mode: "regtest"`, `origin: "http://127.0.0.1:3201"`, `port: 3201`, `authStorePath` (el aislado de `:3201`), `ownerId` (UUID `ADMIN` autorizado existente), `ownerUsername` (obligatorio), `genesisHash`, `wallet: "iso_rt_core_fwd"`, `payerNode: newPayerPubkey` (`LND_*` del motor), `payeeNode: newPayeePubkey` (`ALICE_LND_*`), `channelId`, `dataDir` (nuevo `iso_rt_fwd_state`), orígenes loopback, rutas absolutas `0700`/`0600` de credenciales nuevas y `limits` (`invoiceSats: 5000`, `feeLimitSats: 100`, `depositSats: 5100`, `maxRuns: 1`).
   - Calcular `sha256sum <profile.json>` y fijarlo como `--policy-sha256` (tanto para `scripts/provision-forward-regtest.ts` como para `--forward-regtest`).
4. **Preflight operativo de nodos (post-aprovisionamiento):**
   - Ejecutar `GET /v1/preflight` contra el listener de validación privada conectado a los nodos ya aprovisionados y confirmar HTTP `200`, `prerequisitesSatisfied === true`, `tipsMatch === true`, `lnd.syncedToChain === true`, `lnd.walletSynced === true`, `activeChannels === 1`, `blockers: []`.
   - Recordatorio: el preflight operativo es requisito previo de nodo/cadena/canal (`read-only`); **no** certifica habilitación de `#forward` ni resultado de pago.

---

## 3. Presupuestos concretos e inequívocos y compatibilidad con coinbase en regtest

### 3.1 Presupuesto exacto de infraestructura, canal, fees y 1 corrida controlada

Los límites de código efectivos son: `invoiceSats` entero en `1,000`–`200,000` sats (`ForwardAdmission.ts:42`, `src/api/server.ts:43`), `feeLimitSats = 100` sats fijo sin reembolso (`ForwardAdmission.ts:61`, `CoreLndForwardPorts.ts:84-85`), `depositSats = invoiceSats + 100` en un único UTXO con `confirmations >= 2` y `coinbase: false` (`ForwardAdmission.ts:64, 123`, `CoreLndForwardPorts.ts:72-78`), y canal directo único con funding sin gastar `>= 6` confirmaciones y `coinbase: false` (`CoreLndForwardPorts.ts:97-100`).

Para eliminar ambigüedades, la corrida autorizada fija exactamente:

| Concepto | Presupuesto exacto (sats) | Regla / justificación operativa |
| --- | --- | --- |
| Fondeo on-chain de `iso_rt_lnd_fwd_payer` | **`350,000` sats** (`0.00350000` BTC) | 1 UTXO regular (`coinbase: false`) desde faucet maduro; cubre canal + fee de apertura + reserva anchor/cierre. |
| Capacidad del canal directo único (`local_funding_amount`) | **`300,000` sats** (`push_sat: 0`) | Deja `~3,000` sats de reserva de canal (1%) y margen amplio para commit/anchor fee, asegurando `>= 280,000` sats locales spendables (supera con holgura el tope máximo de factura de código `200,000` + `100` sats). |
| Tope de fee on-chain de apertura del canal (`channelOpenFeeMax`) | **`<= 5,000` sats** | Se deduce de los `50,000` sats remanentes on-chain en `iso_rt_lnd_fwd_payer` (en regtest típico ~`200–2,000` sats); los `>= 45,000` sats restantes quedan como UTXO de reserva on-chain. |
| Fondeo on-chain de `iso_rt_lnd_fwd_payee` | **`0` sats** | No inicia canales ni paga en reverso en esta corrida (`push_sat: 0`). |
| Fondeo de prueba para el depositante (`iso_rt_*` externo a la reserva) | **`50,000` sats** (`0.00050000` BTC) | 1 UTXO regular (`coinbase: false`, confirmado) en la cuenta/wallet de prueba que enviará el depósito de la corrida. |
| **Factura de la corrida (`invoiceSats`)** | **`5,000` sats** | Entero fijo dentro de `1,000`–`200,000` sats. |
| **Reserva de fee Lightning (`feeLimitSats`)** | **`100` sats** | Valor literal fijo en código (`fee_limit_sat: "100"`); sin reembolso del sobrante. |
| **Depósito on-chain exacto de la corrida (`depositSats`)** | **`5,100` sats** (`0.00005100` BTC) | Output único `bcrt1q...` (`5,000 + 100`), `confirmations >= 2`, `coinbase: false`. |
| **Tope de fee on-chain de la tx de depósito (`depositTxFeeMax`)** | **`<= 1,000` sats** | Pagado por el UTXO de `50,000` sats del depositante (nunca descontado de los `5,100` sats del output reservado). |
| **Tope total asignado en todo el entorno fresco** | **`400,000` sats** | `350,000` (pagador) + `50,000` (depositante) + `0` (receptor); gasto neto máximo de la corrida **`<= 11,100` sats** (`5,100` depósito + `<= 5,000` apertura + `<= 1,000` tx depósito). |
| **Tope de fee on-chain total del faucet (adicional)** | **`<= 1,000` sats** | Fee on-chain total acumulado en las transacciones del faucet que asignan los `400,000` sats (desembolso bruto máximo total desde faucet `<= 401,000` sats). |

### 3.3 Autorización explícita asentada (2026-11-25)

- **Autorización del usuario:** el usuario autorizó expresamente implementar el perfil HTTP opt-in (`--forward-regtest` para `http://127.0.0.1:3201/#forward`, `admin-regtest-3201`, UUID `ADMIN` existente, SHA fijado, `Store.openForForward` exclusivo, corrida única `5,000` / `5,100` sats, fee LN `<= 100` sats, sin reenvíos ni segundo hash tras reinicio) y aprovisionar el entorno fresco `iso_rt_*` bajo estos límites exactos (`400,000` sats asignados + fee total del faucet `<= 1,000` sats adicional).
- **Separación de ejecución:** el primer incremento implementa y valida **offline** el perfil HTTP opt-in sin tocar instancias, credenciales ni Stores reales, `:3200`, `ark_lab_*` o mainnet; el aprovisionamiento en vivo queda para la siguiente fase coordinada (no ejecutar aprovisionamiento dos veces).

### 3.2 Corrección de incompatibilidad con coinbase madura en red aislada (faucet vs subsidios)

En Bitcoin `regtest`, cada bloque minado genera una recompensa `coinbase` (`subsidy`) de **50 BTC (`5,000,000,000` sats)** en alturas iniciales (o `2,500,000,000` sats tras el primer halving a altura 150), con madurez obligatoria de **100 bloques** antes de poder gastarse. Por dos motivos de diseño y código, **es incompatible fondear las wallets o depósitos nuevos mediante minado directo sobre ellos**:

1. **Incompatibilidad con topes acotados:** minar un solo bloque hacia `iso_rt_core_fwd` o `iso_rt_lnd_fwd_payer` introduce `2,500,000,000`–`5,000,000,000` sats (de 6,250× a 12,500× por encima del presupuesto total de `400,000` sats).
2. **Incompatibilidad de esquema (`coinbase: false`):** `CoreLndForwardPorts.ts:72` (`inspectDeposit`) y `CoreLndForwardPorts.ts:97` (`send`, verificación del funding del canal) exigen explícitamente **`coinbase: z.literal(false)`**. Todo UTXO coinbase directo es rechazado aunque tenga `>= 101` confirmaciones.

**Regla obligatoria de fondeo aislado:**
- **Subsidios de minado aislados:** toda dirección pasada a `generatetoaddress` pertenece exclusivamente a la wallet minera/faucet aislada (fuera de `iso_rt_core_fwd`, de los nodos LND nuevos y de toda dirección reservada `#forward`).
- **Asignaciones acotadas desde faucet maduro:** únicamente cuando la wallet faucet dispone de coinbases maduras (`confirmations >= 101`), envía **transacciones regulares (`coinbase: false`)** por los montos exactos presupuestados (`350,000` sats y `50,000` sats), devolviendo el cambio a la propia wallet faucet.

---

## 4. Validación privada en puerto temporal, relevo coordinado de `:3201` y verificación terminal

### 4.1 Validación privada en puerto temporal distinto (NO entrega)

Antes de detener el preview `ui-only` de `:3201`, la CLI `--forward-regtest` mantiene estricto el puerto `3201` (`http://127.0.0.1:3201`) en producción, por lo que las validaciones privadas previas al relevo usan: (a) un preview read-only (`SPEND_POLICY=disabled`, `FORWARD_SWAP_ENABLED=false`) en puerto loopback temporal para verificar `GET /v1/preflight` y `GET /v1/health` contra los nodos `iso_rt_*` nuevos sin `router.macaroon` ni tocar el `DATA_DIR` canónico, y (b) el harness offline con `testToken` + `port: 0`:

1. **Prueba de persistencia fuera de `tmpfs` y recuperación sin duplicar escritor:**
   - **No duplicar escritor:** tras aprovisionar el `DATA_DIR` canónico con `scripts/provision-forward-regtest.ts`, verificar en una segunda invocación de `Store.openForForward` (o contra otro directorio para el mismo `newPayerPubkey`) mientras el escritor lo mantiene abierto que falla en cerrado (`EEXIST` en `<payerNode>.lock` / `engine.lock`) sin abrir un segundo escritor.
   - **Recuperación durable antes de gastar en vivo:** verificar sobre disco persistente no-`tmpfs` (en el harness privado con servidores de fixture/ensayo para no ensuciar el `DATA_DIR` virgen de `newPayerPubkey`, y verificando apertura/cierre limpio `await store.close()` en el `DATA_DIR` canónico con estado vacío) que:
     - Ninguna operación de LND ocurre antes de existir `DATA_DIR/.environment.json`, `DATA_DIR/.forward-payer.json`, `DATA_DIR/state.json`, `bindings/<newPayerPubkey>.json` y ambos locks en disco persistente.
     - Tras simular respuesta perdida (`INTENT` → `UNKNOWN`) y reiniciar el único proceso escritor, la reapertura del mismo `DATA_DIR` conserva el journal en disco, rechaza un segundo envío (`execute`) y resuelve vía `recover` (`TrackPayment`) sin crear un segundo `DATA_DIR` ni un segundo escritor.
2. **Validación privada HTTP/preflight/UI antes del relevo:**
   - `GET /v1/preflight` (read-only en puerto temporal tras aprovisionar nodos, nunca sobre `:3201` aún) → `200`, `prerequisitesSatisfied: true`, `tipsMatch: true`, `blockers: []`.
   - En pruebas offline (`port: 0` + `testToken`), comprobar `GET /v1/forward/availability` (`true` sólo para el `ADMIN` autorizado), CSRF, `Idempotency-Key` y estado UI `FAILED_INSUFFICIENT_BALANCE` (`src/web/api.ts:265`).

### 4.2 Relevo coordinado sólo del preview `ui-only` `:3201`

Sólo con autorización escrita del usuario para ejecutar el relevo:

1. Verificar explícitamente que `:3200`, `iso_rt_lnd_provider`, `iso_rt_lnd_alice`, `iso-core-lab`, los históricos A/B, el viejo `DATA_DIR` de `:3201` y `ark_lab_*` no serán tocados ni detenidos.
2. Detener de forma ordenada únicamente el proceso `ui-only` que atiende `127.0.0.1:3201`, deshabilitando su relanzamiento automático con la configuración `ui-only` previa, y verificar la liberación de su viejo `engine.lock` conservando intacto su viejo `DATA_DIR` en custodia separada.
3. Arrancar `admin-regtest-3201` en modo `--forward-regtest --policy-path <abs> --policy-sha256 <64-hex>` escuchando en **`127.0.0.1:3201`**, conservando `AUTH_ORIGIN=http://127.0.0.1:3201`, `DEPLOYMENT_ID=admin-regtest-3201` y el `AUTH_STORE_PATH` con el UUID `ADMIN` autorizado existente, pero vinculado exclusivamente al **nuevo `DATA_DIR` financiero fuera de `tmpfs`** y a los **nuevos nodos/credenciales `iso_rt_*`**.
4. Abrir **`http://127.0.0.1:3201/#forward`** y **reautenticar** explícitamente con la cuenta `ADMIN` autorizada existente (sin reutilizar cookies ni sesiones previas).

### 4.3 Corrida controlada y contraste: preflight operativo vs estado web terminal

1. **Preflight operativo en `:3201` (sólo requisitos previos, nunca prueba de swap):**
   - `GET /v1/health` → `200`, `network: "regtest"`, `mode: "regtest"`.
   - `GET /v1/preflight` (sesión `ADMIN`) → `200`, `prerequisitesSatisfied: true`, `tipsMatch: true`, `blockers: []`.
   - `#forward`: `GET /v1/forward/availability` → `200 { executionAvailable: true }` (y `false` / `403` para cualquier otra cuenta).
2. **Admisión, depósito único y ejecución de la única corrida (`5,100` sats):**
   - Generar en `iso_rt_lnd_fwd_payee` una **factura regtest nueva** (`addinvoice --amt=5000 --expiry=600`).
   - En `#forward` (`Reserve deposit`), enviar factura y `5000`; comprobar dirección `bcrt1q...` exclusiva de `iso_rt_core_fwd` y `depositSats: 5100`.
   - Enviar desde la asignación acotada de `50,000` sats **exactamente `5,100` sats en un único output** a la dirección reservada (fee on-chain `<= 1,000` sats) y minar **2 bloques** desde la wallet minera/faucet.
   - En `#forward`, introducir `txid` y `vout`, pulsar `Refresh status` hasta ver `2 / 2` confirmaciones, y pulsar `Pay invoice` (`POST /v1/forward/:id/execute`). Ante respuesta perdida o estado `UNKNOWN`/`INTENT`, usar **únicamente** `Check payment without resending` (`POST /v1/forward/:id/recover`).
3. **Verificación obligatoria del estado web terminal (no declarar confirmado por TXID o envío):**
   - **Estado web terminal (`#forward`):** debe acreditarse mediante lectura posterior `GET /v1/forward/:id` devolviendo estado terminal **`SUCCEEDED`** (o, en caso de fallo de liquidez sin HTLCs, **`FAILED_INSUFFICIENT_BALANCE`** tras la corrección de `src/web/api.ts:265`), sin exponer preimagen por HTTP.
   - **Corroboración independiente en Core:** `gettxout <deposit_txid> <vout> true` (`value: 0.00005100`, `confirmations >= 2`, `coinbase: false`) y `gettxout <channel_txid> <channel_vout> true` (funding del canal sin gastar, `confirmations >= 6`); `getaddressinfo` confirma `ismine: true`, `iswatchonly: false` en `iso_rt_core_fwd`.
   - **Corroboración en LND (`iso_rt_lnd_fwd_payer` e `iso_rt_lnd_fwd_payee`):** `TrackPayment`/`listpayments` con exactamente 1 pago terminal `SUCCEEDED` (`failure_reason: "FAILURE_REASON_NONE"`, `value_msat: "5000000"`, `fee_msat <= 100000`); `lookupinvoice` en receptor con `state: "SETTLED"`, `amt_paid_sat: "5000"`.
   - **Corroboración en journal durable:** `DATA_DIR/state.json` fuera de `tmpfs` contiene la admisión vinculada al outpoint y `forwardPayments[paymentHash]` con `status: "SUCCEEDED"`, `payerNode: newPayerPubkey` y `approvalDigest`.

---

## 5. Prohibiciones explícitas y rollback exacto al preview `ui-only` `:3201`

### 5.1 Prohibiciones (tolerancia cero)

- **Prohibido cambiar la entrega:** nunca entregar un puerto distinto de `127.0.0.1:3201/#forward`, ni un deployment distinto de `admin-regtest-3201`, ni un perfil alternativo de Orca ni un nuevo principal `ADMIN`.
- **Prohibido mezclar identidades o secretos:** nunca compartir cookies, `AUTH_STORE_PATH`, secretos o Stores financieros con `:3200`, con el viejo `DATA_DIR` de `:3201`, con los históricos A/B, ni con `iso_rt_lnd_provider` / `iso_rt_lnd_alice` / `iso-core-lab` / `ark_lab_*`.
- **Prohibido autoaprobar:** ni Astra ni ningún agente puede autorizar presupuestos, aprovisionamiento, cutover ni gasto en vivo.
- **Prohibido almacenamiento volátil o coinbase directa:** nunca ubicar `DATA_DIR`, locks o volúmenes en `tmpfs` (`/tmp`), ni minar coinbases directamente hacia nodos LND, `iso_rt_core_fwd` o direcciones reservadas.
- **Prohibido romper locks o duplicar escritores/Stores:** nunca borrar o editar manualmente `state.json`, `state.tmp`, `engine.lock`, `<newPayerPubkey>.lock`, `.forward-payer.json` o `bindings/<newPayerPubkey>.json`, ni clonar `DATA_DIR` para reintentar una intención en `INTENT` o `UNKNOWN`.

### 5.2 Rollback exacto (ante cualquier fallo o aborto)

1. **Detener únicamente el proceso forward de `admin-regtest-3201` en `:3201`:** cierre ordenado esperando `await store.close()` y verificando liberación limpia de locks (sin tocar `:3200`, `iso_rt_lnd_provider`, `iso_rt_lnd_alice` ni el viejo `DATA_DIR` previo).
2. **Restaurar exactamente el preview `ui-only` `:3201`:** volver a levantar en `http://127.0.0.1:3201` la configuración original `ui-only` de solo lectura (`SPEND_POLICY=disabled`, `FORWARD_SWAP_ENABLED=false`, sin puertos de escritura forward y sin acceso a `router.macaroon`).
3. **Preservar íntegro el nuevo journal financiero y las pruebas:** mantener intactos en disco persistente (fuera de `tmpfs`) el nuevo `DATA_DIR` (`state.json`, `.environment.json`, `.forward-payer.json`, `state.tmp` si existiera, locks), `bindings/<newPayerPubkey>.json`, los volúmenes/seed de `iso_rt_lnd_fwd_payer` / `iso_rt_lnd_fwd_payee` / `iso_rt_core_fwd` y las capturas privadas de Core/LND; cualquier reactivación posterior exige reconciliación previa sobre ese mismo journal preservado y nueva autorización explícita del usuario.
