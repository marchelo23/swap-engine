# BTC on-chain → Lightning in isolated regtest

The forward service is internal; the default app does not install the HTTP
execution gate. The caller supplies the authenticated owner's ID (never a body field),
and the operator pins one provider LND, one payee and one direct channel.
Keep one durable `Store` per payer; do not replace or clone it to retry a send.

Admission validates a fixed-amount regtest invoice (1,000–200,000 sats) before
requesting a fresh native SegWit address from the Core provider wallet. The
reservation is exclusive to the owner and invoice hash. Use a single output for
the exact quoted amount (invoice plus 100 sats); the fixture does not implement
refunds or return unused fee reserve. Core must attest a wallet-controlled,
unspent output with at least two confirmations, and LND must agree with Core's
tip. Before sending, the adapter also checks that the channel funding is still
unspent and has at least six confirmations. An active channel flag alone is not
enough after rebuilding an isolated chain.

`ForwardExecutor` records an irrevocable send intent before using LND Router
REST. `UNKNOWN` is not authorization to resend, even when LND returns no
payment or a failure. Recovery reopens the same journal, tracks on the same
payer, and requires matching hash, preimage, amount and fee evidence before
recording `SUCCEEDED`. The preimage is not persisted. An `UNKNOWN` intent
can also close as `FAILED_INSUFFICIENT_BALANCE`, but only if tracking on the
same verified payer returns the same hash, terminal `FAILED` with
`FAILURE_REASON_INSUFFICIENT_BALANCE`, an explicitly empty HTLC list and zero
fees. The hash and outpoint remain reserved; neither terminal state allows
another send.

To verify on the existing `swap-engine-iso-regtest` stack:

```sh
npx tsx scripts/verify-forward-isolated.ts --spend-isolated-regtest
```

This is an opt-in **funded** fixture: it uses the existing Core wallet to fund
its own reserved output, mines two blocks, and pays Alice 5,000 regtest sats.
It requires exactly one eligible direct channel with live funding and outbound
liquidity. The script rejects a wrong owner, wrong amount, duplicate invoice and
unconfirmed deposit, simulates loss of the terminal payment response, reopens
the store, verifies one send and one tracking request, and checks settlement on
Alice independently. It retains the private journal outside the repository for
reconciliation. If the script fails after a send intent, investigate and
reconcile that record rather than sending the invoice again.

## Isolated validation (2026-11-25)

The first journaled attempt failed before any HTLC was sent: LND listed a stale
channel as active, but Core no longer had its funding output. That invoice was
not resent. A new 200,000-sat channel was opened on the same isolated nodes and
confirmed in Core. With a new invoice, the fixture observed two deposit
confirmations, one Router send, one Router track after reopening the journal,
and Alice independently reported `SETTLED` for 5,000 sats. This is
self-funded laboratory evidence, not an externally funded user swap.

## HTTP y preview web (2026-11-25)

- `#swap` enlaza a `#forward`, un flujo separado de Ark y de los swaps
  inversos. La vista requiere sesión, muestra la factura, dirección exclusiva,
  importe exacto y confirmaciones del outpoint consultado. Sólo muestra pago
  verificado cuando una lectura posterior del estado propio devuelve `SUCCEEDED`.
- La API privada `/v1/forward` sólo acepta una admisión instalada explícitamente
  para un UUID de cuenta en Bitcoin regtest. Las mutaciones pasan el control
  CSRF de origen y sesión. La creación conserva la clave idempotente en disco;
  la ejecución ancla el outpoint y el diario impide un segundo envío. Una
  incertidumbre se resuelve con `recover` (consulta), nunca con otro envío.
- Prueba HTTP automatizada con puertos simulados: cuenta ajena (incluido ADMIN),
  CSRF ausente, replay y conflicto de claves, depósito inexacto, una
  confirmación, respuesta perdida y recuperación. Resultado: un envío y una
  consulta; ningún preimage en HTTP. No es evidencia de un pago real.
- Orca embebido en `http://127.0.0.1:3200/#forward` tras reiniciar el mismo
  preview aislado: sesión HTTP 200, disponibilidad forward HTTP 200 con
  `executionAvailable: false`, controles ocultos y aviso de no disponibilidad.
  La ruta Ark devolvió `executionAvailable: false` sin tocar permisos.

**No habilitar aún.** El arranque del preview no instala los puertos de
escritura forward. La intención `UNKNOWN` se cerró en su diario original
mediante consulta al mismo LND, sin envío. Se encontraron dos diarios
históricos no vacíos del mismo pagador, con hashes y outpoints distintos.
Antes de instalar los puertos, se necesita un único diario duradero y
exclusivo que conserve ambos historiales y sus reservas (no elegir uno
omitiendo el otro ni arrancar con un diario vacío en paralelo);
vincular un perfil local revisado al UUID de la cuenta autorizada, al wallet
Core, al par LND y al canal directo confirmado del stack aislado, con
credenciales privadas y capacidad saliente vigente. En ese perfil, validar
desde Orca el depósito exacto con fondos de prueba, las dos confirmaciones y
la recuperación tras perder la respuesta, verificando un solo envío y
liquidación en el receptor. No se financió ni se pagó ningún swap web en esta
entrega. El alcance de laboratorio sigue sin reembolsos.
