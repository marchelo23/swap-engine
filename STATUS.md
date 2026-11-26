# Estado de la entrega regtest

- Base `ee6c95a`; rama `swaps-regtest-liquid`. Sólo regtest, proyecto `swap-engine-iso-regtest`; no se intervino `ark_lab_*`.
- Alcance pendiente de validación de punta a punta: Bitcoin on-chain → Lightning, Bitcoin on-chain → Ark, Ark → Bitcoin on-chain, Ark → Lightning y Liquid → Bitcoin on-chain. Liquid → Lightning y Ark ↔ Liquid quedan fuera.

## Infraestructura: revalidación en vivo (2026-11-25)

- Tras el reinicio, Core quedó en altura 147 y los índices retenían estado anterior. Se respaldaron únicamente el índice Fulcrum y la caché de Mempool antes de reconstruirlos. LND dejó de reportar `Block height out of range` al avanzar el Core aislado por encima de la altura anterior. Ver [recuperación](docs/isolated-regtest-recovery.md).
- Bootstrap completado; 12 contenedores aislados activos. En altura 246, Esplora coincidió con el tip de Core y NBXplorer reportó sincronización completa. `diagnose` reportó un fallo de consulta de alias de los peers.
- Preflight REST revalidado contra proveedor y Alice: ambos `SERVER_ACTIVE`, tip idéntico al de Core (246), un canal activo, sin bloqueos. LND v0.20.8-beta no emite `wallet_synced`; su `synced_to_chain=true` exige `Wallet.IsSynced()`. La inferencia se limita al build verificado y sólo a diagnósticos. Pagos, firma, broadcast y minería siguen deshabilitados.
- Ark: el valor efectivo persistido era 40, aunque Compose ya declaraba 480. El bootstrap lo reconcilió vía API y comprobó un VTXO de lote no expirado de 200.000 sats para Bob, con compromiso de una confirmación en Core. Es fondeo del laboratorio, no evidencia de un swap.
- Elements: la wallet proveedora reportó dos UTXOs confirmados y gastables, y la usuaria uno. El preflight obtuvo evidencia del activo y verificó Bitcoin, pero mantuvo `LIQUID_FEE_POLICY_UNVERIFIED` y la ruta no disponible por falta de adaptador.

## Verificación automatizada

- Compilación: `npm run build`.
- Pruebas: `npm test`, 525 aprobadas, 1 omitida (ACL de Windows), 0 fallidas.
- Escaneo previo a publicación: `npm run secrets:check`, sin hallazgos.

## Bitcoin on-chain → Lightning (prioridad)

- Incremento offline: `ForwardExecutor` registra una intención durable por hash y outpoint antes del envío, comprueba de nuevo el depósito y recupera por consulta al mismo pagador sin reenviar. Una respuesta perdida, evidencia insuficiente o confirmaciones perdidas requieren reconciliación.
- `b9f3287` verificó admisión, depósito y pago/recuperación con Core/LND aislados fuera de HTTP. La API y la vista forward reutilizan esa admisión; las pruebas HTTP con puertos simulados verifican autorización por cuenta, CSRF, idempotencia, importe exacto y recuperación sin reenvío.
- Orca embebido, cuenta autenticada, `#forward`: disponibilidad HTTP 200/`false`, controles ocultos. Ark conserva `executionAvailable: false`. No se enviaron fondos ni se verificó un swap desde la web. Gate cerrado por falta de un diario canónico que preserve ambos historiales del pagador. Ver [evidencia y condiciones](docs/isolated-forward-regtest.md#http-y-preview-web-2026-11-25).

## Preview web local

- Preview regtest en loopback con Core y ambos nodos LND del stack aislado. Capacidades verificadas para Bitcoin y Lightning; ejecución deshabilitada. Ark y Liquid no se configuraron en este preview.
- Inicio de sesión ADMIN y vista protegida de balances verificados en el navegador embebido de Orca. Credenciales locales fuera del repositorio con permisos `0600`.

### Segundo preview web (2026-11-25)

- `127.0.0.1:3201` operativo en regtest y solo lectura; `:3200` conservó su proceso y respondió a health. Store de autenticación independiente y perfil de navegador Orca aislado para no compartir cookies con `:3200`. Login ADMIN verificado: sesión HTTP 200; disponibilidad forward HTTP 200 con `executionAvailable: false` y aviso visible.
- Recuperación real en el diario original: `UNKNOWN` → `FAILED_INSUFFICIENT_BALANCE`. `trackpayment` del mismo LND regtest, mismo hash, `FAILED`, 0 HTLCs y comisión cero. Se conservan el hash y el outpoint; no se borró ni se reenvió la intención.
- Bloqueo de escritura: dos diarios financieros no vacíos del mismo pagador, con hashes y outpoints distintos (`SUCCEEDED` en uno y `FAILED_INSUFFICIENT_BALANCE` en el otro). No se eligió ni se clonó uno como canónico, no se habilitó la cuenta para ejecución ni se reinició `:3201`.
- Preparación de consolidación `admin-regtest-3201`: herramienta offline probada con fixtures (evidencia por intención, backups privados, exclusión de Store y publicación atómica de un candidato no ejecutable). No se aplicó a diarios reales; el gate sigue cerrado. Ver [protocolo de revisión](docs/isolated-forward-regtest.md#revisión-offline-de-la-consolidación-admin-regtest-3201).
- Preflight `:3201`: HTTP 200, diagnósticos y requisitos correctos, tips coincidentes y sin bloqueos de diagnóstico. El canal directo activo con Alice tenía financiación sin gastar con 8 confirmaciones en Core, saldo local de 191.530 sats, reserva de 2.000 sats y 0 HTLCs pendientes. Orca confirmó que forward sigue no disponible. Ninguna ruta de ejecución nueva; sin depósito ni swap web.
