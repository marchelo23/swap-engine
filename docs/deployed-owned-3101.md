# App 434f519 habilitada en VM, puerto 3101

Commit ejecutado: `434f5196a665e9448c801a235fd069886a4b2d46`.
Release: `/home/truja/deployments/lqwd-swap-engine-434f519`.
Servicio de usuario: `swap-engine-owned-434f519.service`, enabled/active, PID 47173.
Linger de truja ya estaba habilitado. No se necesitó sudo.

```sh
ssh -N -L 3101:127.0.0.1:3101 truja@192.168.56.108
```

URL: **http://127.0.0.1:3101/**. Usar ese origen exacto para cookie/CSRF.
3100 sigue en `127.0.0.1:3100`, PID original 12488 y mismo cwd.
Para usar ambas apps autenticadas a la vez, abrir 3101 en un perfil/ventana privada
separada: `swap_session` es una cookie por host, no por puerto, y cada proceso tiene
su propia Sessions. Así se conserva también la sesión del navegador de 3100.

## Configuración aplicada

Unidad: `/home/truja/.config/systemd/user/swap-engine-owned-434f519.service`.
WorkingDirectory: release anterior. ExecStart exacto:

```text
/usr/bin/node --env-file=/home/truja/.local/share/lqwd-owned-434f519-3101/regtest.env --import tsx src/main.ts
```

APP_MODE=regtest, ENABLE_LIVE_SWAPS=false, PORT=3101,
AUTH_ORIGIN=http://127.0.0.1:3101.
DATA_DIR=`/home/truja/.local/share/lqwd-owned-434f519-3101/app-data` (nuevo y separado).
AUTH_STORE_PATH=`/home/truja/.local/share/lqwd-auth-0160f6b/auth/users.json` (existente, sin modificar).
Se reutilizan únicamente rutas de lectura existentes: Core 127.0.0.1:18443,
wallet lqwd-lab, provider LND 127.0.0.1:8080 y Alice LND 127.0.0.1:8081,
sus certificados y macaroons readonly. No se copiaron secretos.

Endurecimiento confirmado por systemd: NoNewPrivileges=yes, PrivateTmp=yes,
ProtectSystem=strict, ProtectHome=read-only, UMask=0077, Restart=no;
red limitada a localhost y escritura permitida únicamente en el nuevo app-data.
El proceso escucha solo en 127.0.0.1:3101. La unidad no contiene argumentos JIT,
autorización, contraseña de vault ni credenciales para pagar/firmar/settle.

## Evidencia

- Build de release correcto y npm audit cero. Los 182 archivos versionados
  corresponden al commit, normalizando CRLF del archivo creado en Windows;
  no hubo diferencias de contenido. SHA256 del archivo de release:
  `9f82e6fd1ca104fb83d44f53ac8403b71656c75ee9b71afb68677ef99bcee774`.
- Health 3100/3101: HTTP 200, network regtest, liveSwapsEnabled=false, readOnly=true.
- Preflight real de 3101: HTTP 200, prerequisitesSatisfied=true, blockers vacío.
- Sesión, Operations y availability anónimos: 401; login inválido y login con
  Origin ajeno: 401. No se enviaron operaciones financieras para probar el gate.
- El coordinador verificó independientemente por túnel una cuenta existente:
  login/sesión/Operations/availability 200, controlledReverseConfigured=false,
  executionAvailable=false y preparedSwapIds vacío (mensaje msg_dda784e829a4).
- CSRF positivo y logout están cubiertos por las pruebas de navegador/servidor del
  commit desplegado; el worker no repitió ese POST autenticado en vivo porque no
  recibió una credencial, conforme a la instrucción posterior del coordinador.
- Hashes de cuentas y state.json originales idénticos antes/después; mismo proceso
  original de 3100. Nuevos quotes/swaps/jitExecutions/controlledExecutions: cero.
- Journal revisado: solo arranque del servicio y api_listening, sin credenciales.
- Evidencia privada sanitizada en VM:
  `/home/truja/.local/share/lqwd-owned-434f519-3101/verification-final.json`,
  `verification-preauth.json`, `baseline.json`, `audit.json` y `build.log`.

## Necesidad exacta para preparar y habilitar un swap

La app está habilitada; el run concreto todavía no está preparado. Preflight valida
conectividad, mientras el gateway permanece cerrado hasta un montaje nativo explícito.
No se generaron claves, factura, aprobaciones ni autorización en esta tarea.

1. Elegir cuenta propietaria por UUID y verificar su destino Alice, identidades
   provider/payer y canal directo, UTXO vigente del provider y cambio propio, altura
   fresca y timeout=tip+30. El UTXO ya gastado y la factura SETTLED del test anterior
   no constituyen un nuevo run.
2. Preparar un RUN_DIR privado distinto, spec exacto y custodia durable de hash,
   preimagen/clave claim y clave refund; restaurar y comparar un backup cifrado
   separado. Definir recuperación de cancelación/refund y acciones inciertas.
   Esos materiales aún no existen para un run nuevo en este servicio.
3. Tras revisión explícita, la fase invoice-only requiere su aprobación separada y
   macaroon invoices limitado. Crear una factura es un cambio de estado y no se hizo.
   Perfil existente: principal 50,000, factura 50,750, claim 500, funding <=1,000,
   routing <=100 sats; expiry 3,600 s, CLTV delta 80, máximo dos bloques de prueba.
4. Validar factura exacta, custodia, identidad, input/cambio, liquidez y recuperación
   antes de emitir un sobre JIT nuevo y limitado. No se emitió ese sobre ahora.
5. Montaje revisable para estado únicamente:
   `src/main.ts --controlled-reverse --serve-status-only --run-dir ABS
   --spec-sha256 SHA --ui-config-sha256 SHA`; ui-access.json debe contener
   `{ownerId: UUID, origin: "http://127.0.0.1:3101", port: 3101}`.
6. Para ejecución posterior, el loader exige `--serve-jit`, SHA de spec/action/
   backup/autorización/UI y contraseña del vault por stdin protegido, nunca en
   environment, argv o navegador. La unidad actual carece de ese stdin y solo
   permite escritura en app-data; será necesario revisar la ampliación al store
   exacto del run y el suministro protegido del secreto antes de cambiar 3101.
   Se conserva la misma Sessions; no basta un flag HTTP ni ENABLE_LIVE_SWAPS.

No se debe reiniciar ni alterar 3100 para ese montaje. Solo después de revisar un
run nuevo y sus límites puede habilitarse su acción de ejecución en la UI.
