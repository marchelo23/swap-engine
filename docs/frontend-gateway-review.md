# Candidato integrado regtest

Frontend incorporado: `29d865e`, incluidas las pilas de balances de `360d6ca`.
Se preservan el gateway de `95d47b7`, una sola Sessions, Account y Operations.
Actualización de DeepSeek reproducida en esta rama, conservando dependencias web:
bitcoinjs-lib 7.0.5, ecpair 3.0.2, zod 4.6.7; su worktree no fue modificado.

La UI usa cookie HttpOnly y CSRF real; persiste clave y cuerpo antes de ejecutar,
consulta disponibilidad y estado del propietario, y no transforma incertidumbre
en otra ejecución. Las pruebas de navegador nuevas pasan por login, gateway y
persistencia reales, con el ejecutor financiero sustituido por un adaptador
simulado sin nodos. Cubren resultado normal, recarga, factura/cotización retenida,
resultado ambiguo, reconciliación separada y logout que revoca acceso.

Preparación de despliegue, **sin instalación ni reemplazo del servicio existente**:

- Bundle de código público validado en un directorio temporal único de VM; excluye
  `.env`, datos, cuentas, macaroons, cookies, claves y vaults.
- `deploy/owned-review.env.example`: puerto 3100, datos nuevos en
  `/home/truja/reverse-ui-review/data`, APP_MODE=regtest y ENABLE_LIVE_SWAPS=false.
  AUTH_STORE_PATH debe apuntar al archivo de cuentas existente, sin copiar secretos.
- `deploy/swap-engine-owned-review.service`: unidad distinta y no instalada,
  listener de aplicación loopback y red restringida a localhost; no argumentos JIT,
  sin reintento automático, acceso de escritura solo al nuevo directorio de datos.
- Tras revisión, colocar un release nuevo bajo `/home/truja/reverse-ui-review`,
  conservar el servicio y los datos originales y verificar que 3100 esté libre.
  Preparar `current`, `review.env` y `data` como artefactos nuevos; no sobrescribir
  archivos ni sustituir enlaces existentes. La contraseña y las credenciales de
  acciones no forman parte del release ni de la unidad.
- Acceso previsto por túnel: `ssh -N -L 3100:127.0.0.1:3100 truja@192.168.56.108`.
  La configuración inicial muestra gateway cerrado. Un run necesita una revisión
  separada de owner/destino, custodia restaurada y autoridad nativa de vigencia
  limitada; no se crea ni reutiliza autorización mediante HTTP o environment flags.

Contrato de arranque/control: `integrated-owned-reverse.md` y `owned-regtest-api.md`.
No se crearon facturas ni se hicieron pagos, firmas reales, broadcasts o minería.

## Evidencia

- Build Windows y POSIX correcto; `npm audit`: cero vulnerabilidades, incluidas
  dependencias transitivas. Tiny-secp256k1 permanece en 2.2.4.
- Suite completa POSIX: 355 pruebas, 354 aprobadas, una omitida por plataforma;
  navegador: 11/11, incluidas dos pruebas con cookie/CSRF/gateway reales.
- La suite Windows tuvo cinco fallos asociados a EPERM de rename y persistencia
  incierta; no se relajó la escritura durable. El destino POSIX pasó íntegramente.
- `systemd-analyze verify deploy/swap-engine-owned-review.service`: correcto.
- Escaneo de secretos: 182 archivos y 341 blobs históricos, cero hallazgos.
- Fuentes públicas y logs: `/tmp/frontend-gateway-a3d6398a5d9d.fIBWfqdj/source`;
  logs vecinos `audit.json`, `build.log`, `full.log`, `browser.log`, `unit.log`
  y `manifest.sha256`. Archivo probado SHA256:
  `6e64f17af23b3df8a836bf1e40081c8c5ff6e35446b6d1acfe86375d4623b70e`.
- Sin cambios en servidor/auth/core respecto a `95d47b7`, ni en fuente frontend
  respecto a `29d865e`; las pruebas nuevas y el comando test:web son adicionales.
- Hashes originales de VM conservados antes/después: package-lock
  `c2a95be2733289a0f0e37d25df19c7c72010e583d083ffd7b1a60d5e03a80892`,
  servidor `df20564741efc530a601a7e8e7219041aaecd5f4fda1612ee44da7eb31941c5b`.

Pendiente antes de instalar: aprobar ubicación del release y archivo de cuentas
existente, confirmar puerto/origen del túnel y preparar datos nuevos con permisos
0700 y environment 0600. No se ejecutaron daemon-reload, start ni restart;
el servicio actual, sus credenciales y sus datos no fueron sustituidos.
