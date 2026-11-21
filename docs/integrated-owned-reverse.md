# Montaje integrado owned reverse

Base incorporada localmente: `origin/main` en `d5e88ef` (autenticación y Operations).
Rama de revisión: `review/verified-reverse-api-0d9745ea`.
No se modificaron otros worktrees, frontend, Operations ni autenticación de main.

`createApi` instancia una sola `Sessions`, instala el gateway antes de las rutas
genéricas y conserva login/logout/CSRF/roles existentes. `startApplication` conecta
el loader nativo a ese mismo gateway; no hay otro login ni token de operador en el
navegador. Las rutas privadas antiguas del ejecutor están en `operatorServer` y
no se instalan en el servidor público.

Arranque por defecto: `npm start`, gateway cerrado. La instalación requiere
`APP_MODE=regtest` y argumentos explícitos; `ENABLE_LIVE_SWAPS=false` se conserva.
Ejemplo exacto parametrizado para revisión, **no ejecutado en nodos reales**:

```sh
APP_MODE=regtest ENABLE_LIVE_SWAPS=false \
AUTH_STORE_PATH=/ABS/EXISTING/users.json AUTH_ORIGIN=http://127.0.0.1:3000 \
npm start -- --controlled-reverse --serve-status-only \
  --run-dir /ABS/REVIEWED_RUN --spec-sha256 SPEC_SHA256 \
  --ui-config-sha256 UI_SHA256
```

Para un run nuevo autorizado se sustituye `--serve-status-only` por `--serve-jit`
y, después de `--spec-sha256`, se añaden en este orden
`--action-config-sha256 ACTION_SHA256 --backup-config-sha256 BACKUP_SHA256
--authorization-sha256 AUTHORIZATION_SHA256`; `--ui-config-sha256` queda al final.
El loader verifica los archivos protegidos, restauración de custodia, identidad,
input/cambio, canal, tarifas, factura y vigencia existentes antes de montar.
El modo JIT recibe la contraseña de vault por stdin; status-only no la necesita.
El store de la app y el store del run deben ser distintos para conservar sus locks.

`ui-access.json`: `{ownerId: UUID_DE_CUENTA_EXISTENTE, origin: ORIGEN_EXACTO, port: 3000}`.
Su SHA256 y permisos se verifican; no contiene token ni claves. Origin debe coincidir
con el origen de la aplicación. Credenciales Core/LND y custodia quedan en servidor.

Contrato HTTP: el existente en `owned-regtest-api.md`, sin cambios para frontend.
Cookie `swap_session` HttpOnly; POST con Origin, `x-csrf-token`, JSON e Idempotency-Key.
Consultar primero `/v1/reverse/availability`; habilitar solo con `executionAvailable`
y `allowedActions` del swap. La cotización histórica puede estar vencida: la
autoridad JIT y el servidor validan y generan una única cotización idéntica vigente.
Ante 202/desconexión, consultar estado y reconciliar; nunca generar otra ejecución.

Pruebas nuevas HTTP arrancan la app real con login real y adaptadores de nodos
simulados: propiedad entre USER/ADMIN, CSRF/origen, Operations sin regresión,
concurrencia, replay tras reinicio, revocación/logout, incertidumbre y recuperación
solo lectura, rechazo en simulación y fallo de preparación sin reintento.
Una prueba POSIX arranca el proceso real en regtest con rutas de credenciales
inexistentes, verifica gate cerrado y salida SIGTERM liberando el lock.

Evidencia de validación: build Windows/POSIX correcto; suite enfocada POSIX 37/37;
suite completa POSIX 355 pruebas, 354 aprobadas y una omitida por plataforma;
pruebas de navegador Playwright 8/8 con Chromium aislado en el mismo directorio;
escaneo de secretos 177 archivos/323 blobs, cero hallazgos. Código público probado
en `/tmp/owned-main-165beca9e540.Yn6wnHF9/source`; logs adyacentes `build.log`,
`focused.log`, `full.log` y `browser.log`. SHA256 del archivo de fuentes probado:
`4fa08eac4c6952256d98322f47fd6cbd121e2d9ddcaa43dd62838fcb18fc2a78`.

Pendiente de revisión: despliegue y configuración del run/owner aprobado; no se
crearon facturas ni se pagó, firmó, transmitió o minó durante esta integración.
`npm audit` del lockfile heredado registra cuatro avisos (bitcoinjs-lib, ecpair,
valibot y zod); no se cambiaron dependencias ni criptografía como parte del montaje.
Esos avisos se resolvieron posteriormente con las versiones compatibles del
candidato documentado en `frontend-gateway-review.md`, cuyo audit es cero.
