# Estado de la entrega regtest

- Base `ee6c95a`; rama `swaps-regtest-liquid`. Sólo regtest, proyecto `swap-engine-iso-regtest`; no se intervino `ark_lab_*`.
- Alcance pendiente de validación de punta a punta: Bitcoin on-chain → Lightning, Bitcoin on-chain → Ark, Ark → Bitcoin on-chain, Ark → Lightning y Liquid → Bitcoin on-chain. Liquid → Lightning y Ark ↔ Liquid quedan fuera.

## Infraestructura: revalidación en vivo (2026-11-25)

- Tras el reinicio, Core quedó en altura 147 y los índices retenían estado anterior. Se respaldaron únicamente el índice Fulcrum y la caché de Mempool antes de reconstruirlos. LND dejó de reportar `Block height out of range` al avanzar el Core aislado por encima de la altura anterior. Ver [recuperación](docs/isolated-regtest-recovery.md).
- Bootstrap completado; 12 contenedores aislados activos. En altura 246, Esplora coincidió con el tip de Core y NBXplorer reportó sincronización completa. Ambos LND sincronizaron con Core y reportaron un canal activo. El preflight conserva `LND_WALLET_SYNC_UNRESOLVED`; `diagnose` también reportó fallo de consulta de alias de los peers. No se relajaron los chequeos.
- Ark: el valor efectivo persistido era 40, aunque Compose ya declaraba 480. El bootstrap lo reconcilió vía API y comprobó un VTXO de lote no expirado de 200.000 sats para Bob, con compromiso de una confirmación en Core. Es fondeo del laboratorio, no evidencia de un swap.
- Elements: la wallet proveedora reportó dos UTXOs confirmados y gastables, y la usuaria uno. El preflight obtuvo evidencia del activo y verificó Bitcoin, pero mantuvo `LIQUID_FEE_POLICY_UNVERIFIED` y la ruta no disponible por falta de adaptador.

## Verificación automatizada

- Compilación: `npm run build`.
- Pruebas: `npm test`, 516 aprobadas, 1 omitida (ACL de Windows), 0 fallidas.
- Escaneo previo a publicación: `npm run secrets:check`, sin hallazgos.

## Siguiente hito

- Coordinar con Astra Medium el orden y la admisión de rutas. Resolver los bloqueos de preflight y de proveedor/adaptador sin convertir evidencia de infraestructura en una autorización de gasto.
- No se intentó ni se confirmó ningún swap en esta revalidación.
