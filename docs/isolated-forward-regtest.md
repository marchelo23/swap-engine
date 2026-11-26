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
### Revisión offline de la consolidación (`admin-regtest-3201`)

La herramienta de preparación no abre conexiones, no activa el Store ni
instala un `state.json`. Probada sólo con fixtures. La revisión en vivo y
cualquier aplicación requieren autorización separada.

1. Acreditar por fuera de la herramienta el `DATA_DIR` actual de
   `admin-regtest-3201`, y los dos Stores históricos no vacíos del **mismo**
   pagador, con sus rutas canónicas y SHA-256 de `state.json`. Vincular el
   actual al UUID del ADMIN autorizado y cada histórico a su cuenta original;
   no reasignar admisiones de laboratorio al ADMIN.
   Identificar todos los escritores; detener o mantener deshabilitados sólo
   los pertinentes, sin tocar `:3200`. Si algún escritor no respeta
   `engine.lock`, si interviene `:3200`, o si no se puede demostrar aislamiento,
   abortar. Usar Linux y almacenamiento local; no reemplazar, montar encima ni
   mover directorios mientras dure la operación. No retirar un lock existente
   ni un `state.tmp` para sortear un fallo.
2. Reunir las aprobaciones originales y evidencia **independiente** de cada
   hash mediante `TrackPayment` de sólo lectura en `iso_rt_lnd_provider`.
   Acotar cada consulta con `GetInfo` y verificación del ID completo del
   contenedor, antes y después, en el mismo contexto Docker. Confirmar
   `bitcoin/regtest` y la pubkey en ambas respuestas. Conservar las capturas
   originales en local para revisión, sin cabeceras, credenciales ni logs
   públicos. Nunca generar `track` copiando el estado del diario. Si un lookup
   está ausente, es ambiguo o no coincide, abortar; no enviar ni reintentar.
3. Preparar `evidence.json` (`0600`, fuera del repo y de los cuatro directorios):
   `{target:"admin-regtest-3201", payer:<identidad>, payeeNode:<pubkey>, sources:{admin:{sha256,owner},historicalA:{sha256,owner},historicalB:{sha256,owner}}, lookups:{<hash>:{before:<identidad>,after:<identidad>,approval:<ForwardApproval original>,track:<observación>}}}`.
   `sha256` fija los bytes de la fuente de cada rol; `sources.admin.owner` exige
   el UUID canónico en minúsculas del ADMIN autorizado y los históricos conservan
   su cuenta original; el nodo receptor es el de los registros originales, no
   identidades nuevas.
   La identidad contiene `network:"regtest"`, `container:"iso_rt_lnd_provider"`,
   `containerId` (64 hex minúsculas) y `node` (pubkey). Normalizar `track` con
   esquema estricto de `CoreLndForwardPorts.track` (`{status:"SUCCEEDED",hash,preimage,valueMsat,feeMsat}`
   o `{status:"FAILED",hash,reason:"FAILURE_REASON_INSUFFICIENT_BALANCE",htlcs:[],feeMsat:0}`)
   y contrastar campo a campo contra las capturas crudas privadas de `TrackPayment`:
   para `SUCCEEDED`, verificar `failure_reason:"FAILURE_REASON_NONE"`, `payment_hash`,
   `payment_preimage` (`sha256 == payment_hash`), `value_msat` (y `value_sat` si
   existe) y `fee_msat` (`fee_sat` si existe); para `FAILED`, comprobar
   `failure_reason:"FAILURE_REASON_INSUFFICIENT_BALANCE"`, `htlcs:[]`, `fee_msat:"0"`,
   `fee_sat:"0"` y, si existe, `fee:"0"` en la respuesta original. Las entradas
   de `forwardPayments` no pueden incluir campos sensibles o inesperados (p. ej.
   preimágenes o metadatos): el preparador falla en cerrado sin descartar datos.
   No retener preimágenes fuera de este entorno privado. La API offline **no
   autentica el origen ni la vigencia** del JSON: el revisor debe contrastarlo
   con las capturas y la identidad del lab.
4. Tras autorización para usar entradas reales, preparar un directorio vacío
   de revisión `0700` separado de los tres Stores:
   `npx tsx scripts/prepare-forward-consolidation.ts <admin-dir> <histórico-a> <histórico-b> <salida-vacía> <evidence.json>`.
   Toma cuatro `engine.lock` antes de leer y vuelve a verificar su propiedad y
   los bytes de las fuentes antes de publicar. Une ambos mapas forward sin
   deduplicar; valida cuenta, UUID canónico, IDs, reservas y el vínculo uno a uno
   entre cada pago terminal y su admisión original. Una admisión sin pago sólo se
   conserva si no ha fijado un outpoint; cualquier admisión con outpoint sin pago
   o reserva ambigua (`id`, `paymentHash`, `invoice`, `address`, `scriptPubKey`,
   `outpoint` o `(owner, requestKey)`) es rechazada. El estado no forward se limita
   exclusivamente a `schema: 1`, `swaps: {}` vacío y `quotes` actual en `admin`:
   cualquier clave inesperada, mapa poblado inesperado o solapamiento de `quotes`
   (incluso idéntico) se rechaza sin borrar datos.
5. Revisar localmente `admin-regtest-3201-review/`: tres backups byte a byte,
   `candidate.json` y `manifest.json` con SHA-256 de los cuatro y la evidencia.
   Verificar permisos (`0700`/`0600`), hashes contra originales y evidencia,
   cardinalidad exacta y unión íntegra, estados y reservas, y que no aparezca
   ninguna modificación inesperada de estado no forward. Auditar toda admisión
   abierta sin outpoint conservada en `candidate.json` antes de cualquier
   activación futura: comprobar propietario, expiración, estado de la factura en
   LND (`LookupInvoice`/`TrackPayment`) y ausencia o presencia de depósito UTXO en
   Core para su dirección reservada. Ante error de publicación, pérdida de lock
   posterior al `rename` o fallo de durabilidad, la herramienta y su CLI emiten un
   diagnóstico estático seguro de resultado incierto sin filtrar rutas y conservan
   tanto cualquier `engine.lock` sustituto como el bundle no ejecutable: no usar la
   salida ni reintentar a ciegas. No romper locks: `Store.close()` drena las
   transacciones pendientes, verifica la propiedad de `engine.lock` antes de
   desvincular y falla en cerrado si se perdió; los consumidores deben esperar
   `Store.close()` para garantizar exclusión cooperativa entre procesos `Store` y
   mantenimiento offline, sin sustituir el aislamiento de escritores externos ni la
   exclusión persistente por pagador (hito posterior).
   Si se reanudaron escritores, los hashes son sólo evidencia del snapshot:
   cotejar de nuevo bajo exclusión antes de cualquier aplicación futura.
   No renombrar `candidate.json` a `state.json`, no reiniciar ni habilitar
   ejecución como parte de esta revisión.

### Condición para un cutover futuro, no autorizada por esta preparación

Inventariar procesos, unidades/supervisores, tareas programadas, lanzadores
manuales, contenedores y montajes que puedan abrir cualquiera de las tres
rutas o acceder al pagador. Acreditar el `DATA_DIR`, UID, ruta real/inode,
lock y perfil de cada escritor sin leer ni alterar `:3200`. Si algún escritor
no puede identificarse o aislarse, no hay cutover. Con autorización separada,
detener de forma ordenada sólo el escritor `:3201`, impedir su relanzamiento
automático y revalidar los tres fingerprints bajo los locks originales.
Sellar los históricos y backups como archivos privados en custodia separada
(montaje de sólo lectura o propietario distinto, sin permiso para modificar
archivos o padres desde el UID de servicio). Retirar sus rutas de la
configuración escribible y verificar desde la identidad del servicio que no
puede reabrirlos ni recrearlos; `chmod` con el mismo propietario no basta.
Exigir un único destino de escritura y exclusión por pagador que cubra todos
los lanzadores autorizados; una prueba de apertura concurrente debe fallar.
Si falta evidencia de exclusión persistente, conservar el gate cerrado.

### Exclusión persistente por `payerNode` y límites del lock cooperativo

- **Mecanismo implementado (hito offline):** todos los caminos forward con capacidad
  de envío (`ForwardExecutor`, `ForwardAdmission`, `createApi(..., { forward })` y
  `scripts/verify-forward-isolated.ts`) exigen un `Store` abierto mediante
  `Store.openForForward(directory, payerNode)` (y `createApi` exige además que
  `forward.admission` comparta el mismo `Store` canónico que `manager.store`).
  El registro privado por usuario del sistema operativo se deriva vía
  `os.userInfo().homedir` y `process.getuid()` (nunca de `HOME`, `XDG_*`,
  `DATA_DIR` ni flags por escritor) bajo
  `~/.local/share/lqwd-swap-engine/forward-payers/{locks,bindings}`.
- **Vínculo canónico 1:1 y fallo en cerrado:** al inicializar o reabrir se toman
  exclusivamente `<payerNode>.lock` (`O_CREAT|O_EXCL|O_NOFOLLOW`, `0600`) y
  `engine.lock`, y se valida el vínculo persistente cruzado entre
  `bindings/<payerNode>.json` y `<store>/.forward-payer.json` (`storeId`, ruta
  canónica `realpath`, `dev`, `ino`, `uid`), permisos `0700`/`0600`, ausencia de
  symlinks/hardlinks (`nlink === 1`), ausencia de `state.tmp`, JSON estricto sin
  claves duplicadas ni entradas de otro pagador. Cualquier conflicto de otro
  `DATA_DIR`, ruta aliased o reemplazada, pérdida o sustitución de cualquiera de
  los dos locks, metadatos incompletos/inválidos o recuperación incierta falla
  en cerrado (incluso dentro de `beforeSend` antes de transmitir en red y en
  `Store.close()`, sin romper locks ajenos ni auto-recuperar tras `SIGKILL`).
- **Compatibilidad de rutas no forward:** `Store.open(directory)` y las rutas
  no forward (lectura, cotizaciones, diagnósticos, Ark/Liquid/inversos)
  conservan su comportamiento previo en los demás perfiles, pero no pueden instanciar rutas forward.
  En el perfil exclusivo `--forward-regtest` (`:3201`), las mutaciones ajenas (incluida `POST /v1/quotes` y `POST /v1/ark/quotes`) fallan en cerrado con `503` antes de cualquier transacción sobre el `Store` canónico, y todas las capacidades no forward deben figurar deshabilitadas de forma explícita.
- **Límites del lock cooperativo vs permisos/credenciales y custodia real:**
  tanto `engine.lock` como `<payerNode>.lock` son **locks cooperativos** bajo el
  mismo UID del sistema operativo. No impiden que un proceso externo bajo el
  mismo UID (o `root`) invoque `lncli` o LND REST directamente usando
  `router.macaroon` sin pasar por `Store.openForForward`/`ForwardExecutor`, ni
  impiden a ese mismo UID borrar o alterar archivos del registro, del `Store` o
  locks (aunque un escritor activo detectará la pérdida/sustitución vía
  `assertHeld()` y abortará en cerrado antes de enviar o confirmar). La
  custodia real en producción requiere además separación de UID y permisos de
  sistema operativo sobre credenciales (`router.macaroon`, cookies/llaves),
  montajes de sólo lectura o propietario distinto para históricos/backups,
  inventario de todos los lanzadores y verificación de los gates en vivo.
