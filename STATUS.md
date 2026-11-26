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
- Pruebas: `npm test`, 520 aprobadas, 1 omitida (ACL de Windows), 0 fallidas; suite forward dirigida final: 4 aprobadas.
- Escaneo previo a publicación: `npm run secrets:check`, sin hallazgos.

## Bitcoin on-chain → Lightning (prioridad)

- Incremento offline: `ForwardExecutor` registra una intención durable por hash y outpoint antes del envío, comprueba de nuevo el depósito y recupera por consulta al mismo pagador sin reenviar. Una respuesta perdida, evidencia insuficiente o confirmaciones perdidas requieren reconciliación.
- La web aún no ejecuta forward. Faltan admisión por propietario, asignación de un depósito controlado por el proveedor, puertos reales de Core/LND y prueba aislada de pago y recuperación con esos puertos. No habilitar el envío hasta contar con esa evidencia. Ark y Liquid después; reverse no es requisito.
- No se envió ningún pago ni se intentó o confirmó ningún swap en esta revalidación.
