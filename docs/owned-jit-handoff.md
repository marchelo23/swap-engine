# Handoff regtest de truja503 — 2026-11-19

Servicio `swap-engine-owned-3101.service`, release `434f5196a665e9448c801a235fd069886a4b2d46`, loopback `127.0.0.1:3101`. Verificación final 18:37:37 UTC: health 200, NTP sincronizado, PID y único writer 10757, `Restart=no`, `StandardInput=file` protegido y gate general `liveSwapsEnabled=false`.

**Revisión/inicio disponibles hasta 18:45:10.853 UTC (12:45:10 en El Salvador).** Después, ejecución cerrada; no renovar ni recrear automáticamente.

- Swap: `42d07bd0-5a77-4ce1-b598-c40e97da9656`, revisión 3, `INVOICE_CREATED`.
- Hash: `3ca10274c1658a3f3b9f8157fcc543361db89da5512b627f3db28a34ce7a6ad4`.
- Factura OPEN, 50.750 sats, pagado 0, HTLC 0; pago `NOT_STARTED`.
- Principal 50.000; servicio 750; claim 500; recepción 49.500 sats. Funding máximo 1.000 y routing máximo 100 sats; como máximo dos bloques durante ejecución autorizada.
- Alice/payer: `03bd5a96ed1bf8be9211082f5fae1ee1b206625197abed0d92fc1ee5fc8f6c1553`; proveedor: `028da6db7cde29666a95581fa6899e549a80d848212dacf868b2793e9b2b84dc00`.
- Destino Alice: `bcrt1qzaursu8mptw77dln8d0yy884udfkgacrtd7rd2`; cambio/refund del proveedor: `bcrt1qz62y94lnjfj4sqmzwsap2fvleqxkua95znqfwj`.
- Input aprobado: `710a474d7fe1856c89c9a9bbcd1d94eeee07ff5e8600c3ec26d1c31b546a5d28:1`, 4.981.944.054 sats, confirmado y sin gastar.
- Canal directo `135239930281985`, outpoint `ecdb39ab0a5a0fb71fc5b72e4544c0f894a99a68bd94883ec5947819a90f085f:1`; altura 140, timeout 170.

Run privado: `/home/truja/.local/share/lqwd-owned-434f519-3101/owner-truja503-123f8f5b08b9`. Custodia nueva cifrada y copia separada restaurada; ambas copias están en la misma VM, sin independencia física. Password y credenciales permanecen exclusivamente en VM; roles LND limitados a invoices read/write y offchain read/write, Core usa el perfil existente de cookie regtest explícitamente aprobado. El runtime vuelve a verificar input, canal, factura, fees, identidades y custodia antes de pagar.

Creación única de factura precedida de intent durable; lookup-only recovery confirmó el mismo swap. No hubo pago, firma, broadcast ni minería por este montaje. Verificación final: cero requests owned, intents JIT/controlled, funding, claim y minería. El coordinador corrigió reloj y minó un bloque regtest autorizado antes de esta nueva preparación; después confirmó NTP sincronizado.

La factura anterior `4cbc4f0e642b198ec1908ab2970bf45838aab12e46b728671c4758491860e266` se reconcilió CANCELED, pagado 0, HTLC 0 y sin coincidencia en el historial completo de Alice, antes de crear la nueva. Run anterior conservado, store sin cambios y lock liberado. Hash de cuentas intacto: `cc9f2e5a88fd7f9eb44d03245934a05dcc3b000b76360171c202f8728e0e619f`. No se modificó 3100; sigue sin listener desde el reinicio externo previamente reportado.

El coordinador verificó visualmente como truja503: Swap status, Review prepared swap, importes, destino y Start habilitado; **no pulsó Start** (`msg_06939bc96b04`). Usar `http://127.0.0.1:3101/`, Account → Swap status → Review prepared swap. Mantener ese origen exacto y una sesión separada de 3100. Túnel si falta: `ssh -N -L 3101:127.0.0.1:3101 truja@192.168.56.108`.

Contrato: misma Sessions/cookie HttpOnly/SameSite y CSRF; POST `/v1/swaps/reverse` con `{preparedSwapId, expectedRevision}`, `Idempotency-Key` y `X-CSRF-Token`, solo para este owner/plan. Intent durable antes de ejecución, un único intento por swap y recuperación de solo lectura ante incertidumbre; ningún retry financiero automático.

Pruebas de esta tarea: build correcto; Windows HTTP/JIT/readiness 48 aprobadas y 6 omisiones POSIX; Linux loader/restart/HTTP 20/20; navegador con nodos simulados 11/11. Código de aplicación sin cambios. Evidencias VM: `previous-invoice-reconciliation.json`, `custody-verification.json`, `preparation.stdout`, `recovery.stdout`, `runtime-check-123f8f5b08b9.json` y `final-ui-handoff-123f8f5b08b9.json` dentro del run nuevo.
