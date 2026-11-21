# Preparación owned para truja503/Alice

Se preparó una única hold invoice, sin pago, firma, broadcast ni minería.
Owner: `truja503`, UUID `84db8ada-bb4f-4eac-bace-1f3584872cb9`.
Alice LND: `03bd5a96ed1bf8be9211082f5fae1ee1b206625197abed0d92fc1ee5fc8f6c1553`.
Provider: Core/lqwd-lab y LND `028da6db7cde29666a95581fa6899e549a80d848212dacf868b2793e9b2b84dc00`.

## Evidencia real

- Swap: `ccac8057-710d-4aed-92ca-286ca667a755`, INVOICE_CREATED, revisión 3.
- Hash: `4cbc4f0e642b198ec1908ab2970bf45838aab12e46b728671c4758491860e266`.
- Factura OPEN, 50.750 sats, pagado 0, HTLC aceptados 0; caduca
  **2026-11-19 06:27:39 UTC**. No recrearla mientras su estado requiera reconciliación.
- Principal 50.000; claim 500; receipt 49.500; funding máximo 1.000; routing máximo
  100 sats. Altura comprobada 139; timeout 169; invoice CLTV delta 80, expiry 3.600 s.
- Canal directo `135239930281985`, punto
  `ecdb39ab0a5a0fb71fc5b72e4544c0f894a99a68bd94883ec5947819a90f085f:1`.
- Input confirmado y no bloqueado del provider:
  `710a474d7fe1856c89c9a9bbcd1d94eeee07ff5e8600c3ec26d1c31b546a5d28:1`,
  4.981.944.054 sats; solo se inspeccionó y seleccionó, sin gastarlo ni bloquearlo.
- Claim: `bcrt1qzaursu8mptw77dln8d0yy884udfkgacrtd7rd2`, verificado entre las
  direcciones externas existentes de Alice, sin generar dirección nueva.
- Cambio/refund: `bcrt1qz62y94lnjfj4sqmzwsap2fvleqxkua95znqfwj`, propiedad de lqwd-lab.
- Custodia cifrada guardada una vez, copia separada fsync y restauración de ambos
  roles verificadas. Repetición local devolvió los mismos hashes/identidades.
  Backup local de la misma VM: no representa independencia física ante pérdida de VM.
- Intento de comando y de factura persistidos antes del único POST; recuperación
  `--recover-invoice-only` confirmó el mismo swap sin otro POST. No hay payment,
  funding, claim, mining, JIT ni controlled-execution intents.

Run privado en VM:
`/home/truja/.local/share/lqwd-owned-434f519-3101/owner-truja503-abf0d8b383df`.
Backup separado: hermano `backup-truja503-abf0d8b383df`. Passphrase permanece
en archivo protegido fuera de ambos directorios; no se incluye en salida ni Git.
Evidencias sanitizadas: `custody-verification.json`, `preparation-command-intent.json`,
`preparation.stdout`, `recovery.stdout`, `unpaid-invoice-evidence.json` y
`gateway-system-mount-evidence.json` dentro del run.

## Montaje y límites de 3101

Servicio actual: **unidad de sistema** `swap-engine-owned-3101.service`,
enabled/active, User/Group=truja, PID verificado 6055. La unidad user anterior
está detenida/deshabilitada. Release de aplicación sigue siendo `434f519`.
ExecStart conserva env privado y añade únicamente:

```text
--controlled-reverse --serve-status-only
--run-dir /home/truja/.local/share/lqwd-owned-434f519-3101/owner-truja503-abf0d8b383df
--spec-sha256 49bef9269f03955c35fc9bfb980cf5b95563a33017b3404a7df9c9b53c039778
--ui-config-sha256 56ec12c2e56fac459eb23fcd2cb004099905aba98328ca231a2509765d0b656b
```

El store del run está abierto por el mismo PID del servicio y enlaza el owner
correcto con su destino. Health 200, GET de swap anónimo 401; no autorización de
ejecución. Se conservan NoNewPrivileges, PrivateTmp, ProtectSystem=strict,
ProtectHome=read-only y red loopback; ReadWritePaths limita escritura a app-data
y store de este run. No vault/password ni action configuration se carga en este modo.
La instancia Sessions es la misma que atiende login y Operations.

La unidad user no podía superar el guard: el namespace remapeaba ancestros root
a UID 65534. Se reprodujo el fallo con un probe aislado y no se relajó protectedBytes.
La unidad de sistema fue instalada por el coordinador, manteniendo el proceso
sin privilegios. El comportamiento del mapeo user está documentado en
[systemd.exec](https://www.freedesktop.org/software/systemd/man/257/systemd.exec.html#PrivateUsers=).

Durante el incidente hubo un nuevo arranque de VM, externo a este worker; por eso
no persistió el proceso manual de 3100. No se modificó ni reinició ningún nodo.
El lock antiguo de 3101 con PID 47173 se conservó como evidencia después de probar
que el PID no existía y los journals financieros estaban vacíos. Hashes de cuentas
y datos originales de 3100 permanecieron idénticos. La restauración de 3100 quedó
en manos del coordinador; este worker solo restauró/configuró su aplicación 3101.

## Helper nuevo y pruebas

`prepare-owned-custody.ts --prepare-owned-custody --run-dir ABS --policy-sha256 SHA`
recibe el password por stdin. Solo genera custodia local y archivos públicos de
spec, credentials-paths, backup y ui-access; no tiene capacidad de nodo/factura.
Exige política privada revisada, usuario/UUID existente, roles y rutas loopback,
origen 3101 y backup separado. Intento y READY son inmutables, fsync, creación
exclusiva y archivos 0600/directorios 0700. Un intento parcial nunca genera claves
de reemplazo. READY se revalida por hash y restauración; no afirma un estado de factura.

Build Windows y Linux local correcto. Suite POSIX local WSL: **359 pruebas,
358 aprobadas, una omitida**; fuente/logs en
`/home/truja/.cache/orca-owned-tests/abf0d8b383df.jzjISXAc/final-source2` y logs
hermanos `final2-build.log`, `final2-full.log`. La prueba remota original terminó
40/40 antes del nuevo arranque; no se relanzó cuando SSH estaba inaccesible.

## Contrato y próximo paso

Al iniciar sesión como truja503, availability debe devolver
controlledReverseConfigured=true, executionAvailable=false y preparedSwapIds con
el swap anterior. List/status solo son del owner; cookie HttpOnly y CSRF existentes.
La UI puede mostrar este run y sus evidencias; pagar sigue deliberadamente bloqueado.
El coordinador confirmó independientemente por túnel, con sesión truja503: login,
availability y GET swap 200; configured=true, executionAvailable=false,
recoveryAvailable=true, el ID anterior, INVOICE_CREATED revisión 3,
payment=NOT_STARTED y allowedActions vacío (msg_65b6c105412e). No se hizo revisión
visual de la UI en vivo ni POST de ejecución. Helper y pruebas: commit `7ff30b8`.

Para habilitar ejecución después: revisión fresca del mismo invoice OPEN y input/
canal/altura/fees, backup restaurable, credenciales de acción limitadas, suministro
protegido del password por stdin y sobre JIT de vigencia acotada instalado por el
operador en el mismo proceso. No se emitió ese sobre en esta tarea. La quote
histórica puede caducar: el JIT existente requotea términos idénticos una vez;
la factura y los efectos inciertos deben reconciliarse, nunca recrearse a ciegas.
