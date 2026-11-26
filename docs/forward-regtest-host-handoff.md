# Traspaso administrativo forward regtest — OP3/OP4

**Única adquisición ya autorizada (E1, 2026-11-26):** el usuario autorizó descargar las dos imágenes fijadas por digest **sólo en el almacén rootless del despliegue nuevo**, bajo `iso_rt_fwd_svc`. No cubre una caché de staging del operador, ni su almacén por defecto, ni importación desde éstos. Registrar la instrucción original por separado de OP2–OP7; este resumen no es una cita textual ni un nuevo pedido de aprobación de E1.

**Pendiente:** E1 no se ejecutó; depende de que el administrador habilite y verifique la cuenta y el almacén (OP3/E2, no autorizado por E1). La topología y el arranque (resto de OP4/E3), y la transferencia del ADMIN, el relevo, los fondos, el canal, el journal y la corrida (E4) mantienen sus gates separados. El alcance es una topología **nueva** y `127.0.0.1:3201`; no usar `:3200`, mainnet, `ark_lab_*` ni Core, wallets, nodos, volúmenes, diarios o secretos financieros anteriores. Véase el [plan de pagador nuevo](isolated-forward-fresh-payer.md).

Revisión documental: dictamen de imágenes atribuido a Claude Sonnet 5.5 (High), declarado por Antigravity CLI y no verificado independientemente. Esta actualización se realizó con OpenCode v2.4.1: `openai/gpt-6.2-sol`, variante `low`, según `.data[].model` de los mensajes `assistant` en `GET /api/session/<id>/message` de la sesión activa.

## Qué permite el host hoy (2026-11-26, sólo lectura)

- Linux `x86_64`; `/home` persistente en Btrfs, ~27 GiB libres. Podman local del UID 1000 es rootless, usa `vfs` y `podman images -aq` no devuelve imágenes. Hay un `bitcoind` local v29.4.0, no el Core seleccionado; `lnd` no está en `PATH`. No se usaron para arrancar nada.
- El registro público sirvió ambos índices y manifiestos `linux/amd64`; el SHA-256 de los cuerpos coincidió con los digests abajo. Las peticiones `HEAD` a los blobs de configuración y capas devolvieron HTTP 200. Es evidencia de accesibilidad del registro, **no** de descarga completa, espacio tras descompresión ni arranque exitoso. Se puede resolver la falta de imágenes bajo un UID autorizado; descargar como UID 1000 no resolvería la custodia.
- No existe `iso_rt_fwd_svc` en NSS. `sudo -n -k -u root /usr/bin/true` devolvió `sudo: a password is required`; las excepciones que lista sudo no delegan esta custodia. `/var/run/docker.sock` apunta a `/run/podman/podman.sock`; la conexión directa al socket rootful devolvió `connect: permission denied`. UID 1000 figura en `docker`, pero actualmente no puede atravesar `/run/podman` (`root:root`, `0700`). Existe un socket **rootless del UID 1000**; no es el de la cuenta dedicada. No usar reglas de sudo ajenas, ese socket, otro daemon ni un cambio de permisos como atajo. No se acreditó capacidad autorizada para OP3/OP4 sin administrador.
- Tras la autorización acotada de adquirir ambas imágenes **sólo en el almacén nuevo**, `getent passwd iso_rt_fwd_svc` siguió sin entrada (~0,003 s). `podman --remote=false info` (~2,57 s) identificó únicamente el `GraphRoot` del operador (`$HOME/.local/share/containers/storage`) y su `RunRoot` (`/run/user/1000/containers`); no son los del despliegue nuevo. No se hizo `pull` ni se generaron RepoDigests locales. Hace falta que el administrador habilite OP3 y verifique el almacén dedicado; no hace falta acceso rootful para el operador.
- `127.0.0.1:3201` sigue escuchando. No se paró ningún proceso ni se obtuvo contenido de archivos de autenticación o credenciales.

## OP3 — cuenta, almacenamiento y permisos (administrador)

1. Crear o validar la cuenta local dedicada `iso_rt_fwd_svc`, distinta del operador, con UID/GID propios, home privado persistente (por ejemplo `/home/iso_rt_fwd_svc`), contraseña bloqueada, sin shell de login, SSH, sudo ni pertenencia a grupos de administración de contenedores. El administrador ejecuta las comprobaciones con `runuser -u iso_rt_fwd_svc -- …` desde su contexto autorizado, no concede `runuser`, sudo ni acceso de socket al operador. Verificar con `getent passwd`, `id`, `passwd -S`, `sudo -l -U iso_rt_fwd_svc` y las políticas SSH efectivas. Elegir rangos de `/etc/subuid` y `/etc/subgid` no solapados (incluyendo los de otros usuarios), verificar `newuidmap`/`newgidmap` y que `podman unshare cat /proc/self/uid_map /proc/self/gid_map` funciona bajo el UID dedicado. Si una cuenta o rango ya existe pero no coincide con el inventario aprobado, detenerse; no adoptarlo ni desplazarlo.
2. Usar Podman **local** (`podman --remote=false`), sin `DOCKER_HOST`/`CONTAINER_HOST` heredados y sin habilitar API de contenedores. Dotar al UID de su runtime privado `XDG_RUNTIME_DIR` (`0700`, normalmente `/run/user/<uid>` administrado por systemd), no usar el runtime del operador. Si se usan unidades de usuario y se necesita operación sin login, sólo el administrador puede autorizar `loginctl enable-linger iso_rt_fwd_svc`; comprobar primero `loginctl show-user iso_rt_fwd_svc -p Linger -p RuntimePath`. No habilitar `podman.socket`. Confirmar el entorno con el lanzador real de las unidades, no sólo con `runuser`.
3. Con `umask 077`, validar o crear directorios bajo el home dedicado para `bitcoin`, `lnd-payer`, `lnd-payee`, `state`, `secrets`, `profile` y `auth`; mantener `forward-payers` en el home efectivo del servicio (según el código). Datadirs, auth, registry, journal, política y `GraphRoot` en disco persistente; sólo `RunRoot`/runtime efímero. Verificar `findmnt -T <ruta>`, `df -h`, `stat`, `namei -l` y `getfacl -p` en las rutas reales: directorios de custodia `0700`, archivos sensibles `0600`, UID correcto, sin ACL extras, enlaces simbólicos ni hardlinks para archivos del perfil. Validar también permisos de ancestros: dueño root o UID del servicio, sin escritura ajena. No usar `:U`, cambios recursivos ni arreglar un directorio preexistente desconocido; detenerse ante diferencias. Para el código ejecutable del servicio, desplegar un artefacto revisado de sólo lectura para ese UID, no ejecutar desde el checkout modificable del operador.
4. Registrar pruebas de permisos desde **cada identidad real**, sin imprimir contenidos. Positivas, desde el UID dedicado: `podman --remote=false info --format '{{.Host.Security.Rootless}} {{.Store.GraphRoot}} {{.Store.RunRoot}}'` debe reportar `true` y rutas dedicadas; `test -r` sobre sus archivos `0600` y `test -w`/`test -x` sobre sus directorios y registry; probar creación exclusiva de un archivo desechable en un directorio de prueba dedicado, no en el journal. Negativas, desde el operador sin elevación: `test ! -x "$custodia"`, `test ! -r "$custodia/auth/users.json"` y lo mismo para policy, cookie y macaroon Router, y `test ! -w "$custodia/state"`; desde la cuenta dedicada, verificar que no atraviesa el runtime del operador ni lee almacenes privados ajenos. Primero verificar existencia/ownership como administrador para no confundir `ENOENT` con denegación. Para ambos UID, probar conexión de sólo lectura (`podman --remote --url unix:///run/podman/podman.sock version` y el alias `/var/run/docker.sock`): esperar denegación efectiva si existe el socket. Inventariar **otros endpoints rootful** y reglas de sudo efectivas; no aceptar acceso rootful como control operativo, ni confiar en el grupo `docker` actual como garantía futura. Desde el operador, el socket dedicado no debe existir ni ser alcanzable. No relajar permisos ni cambiar membresías existentes sin revisión separada.

**Límite de custodia:** «mismo UID» significa un único dueño para los archivos privados del servicio, distinto del UID del operador, no ejecutar el servicio como operador. Podman rootless separa del host privilegiado, no separa procesos con el mismo UID. El servicio y su Podman comparten esa frontera; root sigue siendo custodio de confianza. Quien pueda ejecutar código como ese UID, modificar su lanzador o controlar su Podman puede acceder a sus secretos. Loopback tampoco aísla usuarios locales: autorizar por credenciales, no por dirección fuente. Si se exige separar además el motor de la administración de nodos, revisar otra topología; `0600` no lo proporciona.

## OP4 — imágenes y topología (administrador, bajo el UID dedicado)

Usar los mismos proyectos/versiones que el [Compose de referencia](../deploy/isolated-regtest/docker-compose.yml), pero **no** ejecutar ese Compose ni reutilizar sus recursos. Digests verificados para este host:

| Imagen y tag de referencia | Índice (`sha256:`) | Manifiesto `linux/amd64` (`sha256:`) |
| --- | --- | --- |
| `docker.io/btcpayserver/bitcoin:31.0` | `a753d6fe3d8051ff03015ec77f068d9698b85b9abe8864a783ed22a572c9dcce` | `cc070dffde3073154b508e95ae64b39f433b41874dd8f2cd49c0d1b4d16a15ff` |
| `docker.io/lightninglabs/lnd:v0.20.8-beta` | `d23faa661edebdcb0c633ce6bc33a7abdcdb82283bc53620463bf2b00a30c8cb` | `8d830eaad90dce0be3aab2d3c07afbd24b92732927228e83486f91c4925d556d` |

Fuentes de publicación: [BTCPay Bitcoin image](https://hub.docker.com/r/btcpayserver/bitcoin), [Bitcoin Core 31.0](https://bitcoincore.org/en/releases/31.0/), [Lightning Labs LND image](https://hub.docker.com/r/lightninglabs/lnd), [release LND](https://github.com/lightningnetwork/lnd/releases/tag/v0.20.8-beta). Core es la imagen mantenida por BTCPay, no una imagen oficial de Bitcoin Core. El tag anotado de LND apunta al commit `33f90e82464daf9e6d2f2a02e754955ba42e2951`, comprobado vía GitHub; el perfil exige ese commit para su excepción de `wallet_synced`. El digest fija bytes del registro; no sustituye una firma de upstream ni prueba el commit de un binario. Usar TLS y la política de confianza aprobada; nunca `--tls-verify=false`.

Comprobación reproducible de sólo lectura ([API de Docker Registry](https://distribution.github.io/distribution/spec/api/)); repetir con las dos filas, usando un directorio temporal privado para metadatos públicos:

```sh
# bash; repo sin prefijo docker.io, index y amd64 son los hex de la tabla.
set -euo pipefail
umask 077
work=$(mktemp -d)
trap 'rm -f "$work/index" "$work/amd64"; rmdir "$work"' EXIT
token=$(curl -fsS --max-time 15 \
  "https://auth.docker.io/token?service=registry.docker.io&scope=repository:$repo:pull" |
  jq -er .token)
base="https://registry-1.docker.io/v2/$repo/manifests"
curl -fsS --max-time 30 -H "Authorization: Bearer $token" \
  -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json' \
  "$base/sha256:$index" -o "$work/index"
printf '%s  %s\n' "$index" "$work/index" | sha256sum -c -
jq -e --arg d "sha256:$amd64" \
  '[.manifests[] | select(.platform.os=="linux" and .platform.architecture=="amd64") | .digest] == [$d]' \
  "$work/index" >/dev/null
curl -fsS --max-time 30 -H "Authorization: Bearer $token" \
  -H 'Accept: application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' \
  "$base/sha256:$amd64" -o "$work/amd64"
printf '%s  %s\n' "$amd64" "$work/amd64" | sha256sum -c -
```

### Paso mínimo del administrador para E1

**Helper exclusivo de adquisición E1; no ejecutar hasta revisión independiente.**
No crea cuentas, grupos, rangos, directorios ni unidades, no adopta un almacén
usado y no modifica NSS. El modo por defecto sólo imprime el plan. OP3/E2 es
administrativo y separado: en un host files-only puede hacerse alta local
manual si la política lo admite. En este host (`files systemd winbind`),
**no** usar `getent` negativo o una enumeración incompleta para dar por libre
un ID o intervalo, ni pasar a files-only para sortear el directorio.

**Pedido al custodio de este host (sin cambios para este pedido):** confirmar
por canal privado si existe autorización OP3/E2 y quién puede validar, con
fuentes autoritativas de files, systemd y winbind, el nombre exclusivo
`iso_rt_fwd_svc`, su UID/GID común y un intervalo exclusivo de 65536 IDs
para ambos subuid/subgid (incluidas identidades no enumerables, miembros
del grupo, reservas y mapeos del directorio). Devolver el UID/GID e inicio
propuestos, el resultado de esas comprobaciones y qué fuente no pudo
validarse; si hay duda o colisión, dejar E1 cerrado. No enviar listados,
configuración sensible, contraseñas o credenciales.

Sólo una vez autorizado OP3/E2, el custodio crea y verifica la identidad
dedicada, grupo sin otros miembros, nologin y contraseña bloqueada,
subuid/subgid locales exactos, sin linger ni login runtime. Prepara con
owner UID:GID del servicio, `0700` y sin ACL extendidas ni heredables:
`/home/iso_rt_fwd_svc` con sólo los directorios vacíos `bitcoin`, `lnd-payer`,
`lnd-payee`, `state`, `secrets`, `profile`, `auth`, `forward-payers`, `storage`,
`config`, `data`, `cache`; `/run/iso_rt_fwd_svc` con sólo `storage` vacío.
No reutilizar directorios ni remontar rutas. Si necesita otro backend subid
o layout, parar y volver a revisión.

Antes de usar `--attest-op3`, el custodio verifica y registra OP3/E2, control
exclusivo de la cuenta (sin procesos de terceros), capacidad de disco, política SSH (denegación efectiva
incluso por claves), PAM de `runuser`, configuración/política/mirrors globales
de Podman y acceso efectivo a endpoints privilegiados según OP3. Verifica
los índices públicos con la receta anterior; el helper fija y verifica los
manifiestos de plataforma, no consulta los índices. Hacerlo en ventana de
administración exclusiva (sin altas/cambios de identidades en paralelo).
No usar el flag si falta cualquiera de esas comprobaciones. El preflight
corrobora localmente, no sustituye esa atestación ni prueba unicidad global.

Desde una terminal local del custodio, recibir el script autocontenido y los
64 hex del SHA-256 aprobado por revisión por canal de confianza separado.
**Después de revisión y autorización OP3/E2**, instalar copia en `/root`
(no ejecutar desde checkout) y correr sólo el preflight, definiendo
`fuente`, `sha`, `uid` y `subid` con los valores aprobados:

```sh
/usr/bin/sudo -v &&
/usr/bin/sudo -n /usr/bin/test ! -e /root/forward-regtest-host.py &&
/usr/bin/sudo -n /usr/bin/test ! -L /root/forward-regtest-host.py &&
/usr/bin/sudo -n /usr/bin/install -T -o root -g root -m 0500 -- "$fuente" /root/forward-regtest-host.py &&
printf '%s  /root/forward-regtest-host.py\n' "$sha" |
  /usr/bin/sudo -n /usr/bin/sha256sum --strict -c - &&
/usr/bin/sudo -n /usr/bin/env -i PATH=/usr/sbin:/usr/bin LC_ALL=C \
  /usr/bin/python3 -I /root/forward-regtest-host.py --id "$uid" --subid "$subid" --attest-op3 --preflight
```

No usar `sudo -S`, ni capturar o transferir la contraseña. La autenticación
ocurre en `sudo -v`; el helper no lee stdin. El preflight no invoca `runuser`
ni Podman (incluso `podman info` puede inicializar el almacén). Si rechaza,
no inició E1: devolver el diagnóstico y resolver OP3/E2, sin adoptar recursos.
No ejecutar la mutación E1 hasta autorización de la revisión. En E1, tras
revalidar preflight, el helper verifica contexto UID/grupos, mapas rootless
y rutas VFS dedicadas antes del primer pull, con authfile efímero privado
y entorno limpio. Si E1 inició y falla o se interrumpe, conservar estado,
inventariar como custodio y acordar reconciliación manual; no reintentar, no
hacer `prune`, ni borrar directorios, imágenes o identidades. El runtime
efímero caduca al reinicio y no lo recrea E1.

Devolver **sólo** pruebas no sensibles: resultado de preflight y, únicamente
tras una E1 autorizada, `Rootless=true` con rutas dedicadas, ambos pines
verificados, dos imágenes `linux/amd64`, espacio antes/después y constancia
de inventario intacto de contenedores, redes y volúmenes. Esto no acredita
arranque ni custodia financiera.

### OP4 restante — sólo tras su gate

- Inventariar contenedores, red y volúmenes bajo **ese** UID; nombres nuevos `iso_rt_bitcoin_fwd`, `iso_rt_lnd_fwd_payer`, `iso_rt_lnd_fwd_payee`, `iso_rt_fwd_net`, con etiqueta de propiedad exclusiva del despliegue. Validar mediante `inspect` nombres, etiqueta, digest, argumentos, montajes y puertos; si ya existen y no coinciden con el plan, parar. No usar `--replace`, migraciones automáticas ni `prune`. Respaldar con custodia antes de futuros cambios.
- Red privada dedicada, sin host networking ni conexiones a redes ajenas: Core RPC interno `18443`, ZMQ `28332/28333`, LND P2P y gRPC sólo internos. Si el motor va en el host, publicar sólo Core RPC y las dos REST LND, explícitamente en `127.0.0.1` (candidatos `38443`, `38080`, `38081`, sujetos a `ss -Hln` antes y después). Verificar que la versión/backend rootless materializa la publicación en loopback con la red aislada elegida y que no hay salida a redes de pares externas; si no se consiguen ambas cosas, no abrir más interfaces como arreglo. No montar sockets, home entero, checkout ni volúmenes de laboratorio; no usar `--privileged`. Montajes de datos separados, y configuración sensible por archivos privados, no por argumentos, env de contenedor ni logs.
- Arrancar sólo con las referencias por digest y `--pull=never`. Usar el Core dedicado `iso_rt_bitcoin_fwd` con datadir y cadena nuevos; no vale una wallet separada dentro del Core anterior. Definir por separado la wallet minera/faucet y origen del fondeo en la cadena nueva antes de los gates financieros; no usar fondos del laboratorio anterior. Configurar explícitamente Core `regtest`, índice de tx, ZMQ `tcp://0.0.0.0:28332`/`:28333` internos y sin descubrimiento de pares externos. Usar la cookie nueva exigida por el perfil; para LND usar autenticación backend nueva en archivos protegidos (configurar `rpcauth` y credenciales correspondientes si se usa contraseña). En LND, `bitcoin.active`, `bitcoin.regtest`, `bitcoin.node=bitcoind`, RPCHost/ZMQ internos y TLS válido para el origen loopback del motor. Custodiar seeds, macaroons admin y credenciales de backend; el motor sólo recibe la cookie requerida, los dos certs, los dos macaroons de lectura y el Router del pagador limitado a `SendPaymentV2`/`TrackPaymentV2` según el perfil, este último retenido hasta la provisión durable y autorización.
- En la futura validación no financiera: comprobar Core `chain=regtest`, génesis `0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206`, ZMQ y wallet exclusiva `iso_rt_core_fwd` vacía; comprobar `version`/`commit_hash` de LND en ambos nodos, TLS, `SERVER_ACTIVE`, sincronización y tip coincidente cuando corresponda. Crear seeds nuevas sólo bajo autorización. Los gates de canal/fondeo/preflight del plan son posteriores; no se acreditan aquí.

Referencias de administración: [Podman rootless y almacenamiento](https://docs.podman.io/en/latest/markdown/podman.1.html), [Podman API y sockets](https://docs.podman.io/en/latest/markdown/podman-system-service.1.html), [opciones de puertos y seguridad](https://docs.podman.io/en/latest/markdown/podman-run.1.html), [configuración LND](https://github.com/lightningnetwork/lnd/blob/v0.20.8-beta/sample-lnd.conf), [macaroons de LND](https://docs.lightning.engineering/lightning-network-tools/lnd/macaroons).

## Relevo posterior, sólo tras aprobación del gate correspondiente

Antes del relevo, fijar el SHA completo e inmutable del commit aprobado y el SHA-256 esperado del artefacto de release en el registro del gate. El custodio verifica procedencia (release construido desde ese commit) y compara `sha256sum` de los bytes instalados con el digest aprobado por canal de confianza. Desplegar en ruta de sólo lectura para servicio y operador, nunca desde checkout, tag o rama mutable. Si faltan esos pines, hay discrepancia o quedan revisiones requeridas sin cerrar, no relevar. El digest del artefacto es distinto del de la política y de los digests OCI.

1. Inventariar privadamente el proceso/unidad y la configuración del preview **sólo `:3201`**. Preparar reversión del preview read-only. El custodio del auth store aislado de `:3201` entrega, mediante transferencia administrativa privada y consistente, un candidato con el mismo registro `ADMIN` (mismo UUID canónico, username, role y hash de contraseña), con owner del UID dedicado y `0600`. Si no hay acceso autorizado al store, parar: no recrear el ADMIN, hacer bootstrap ni modificar el origen para saltar la restricción. Verificar coincidencia sin mostrar UUID ni hash; no migrar cookies o sesiones del navegador, y autenticar de nuevo en el perfil aislado de Orca.
2. Conservar intactos el Store financiero actual y los históricos. Preparar un `DATA_DIR` nuevo/registry exclusivo, `--policy-path` y digest revisados; fijar en la política el auth store dedicado que preserva identidad, `admin-regtest-3201`, `http://127.0.0.1:3201`, wallet/nodos/canal nuevos y límites `5000/5100`, fee máximo `100`, `maxRuns=1`. Usar la CLI offline `scripts/provision-forward-regtest.ts` y el perfil `--forward-regtest` según el plan; no copiar journals como sustituto de provisión. Confirmar flags explícitamente apagados para todas las demás rutas, ejecución general y minería automática. No arrancar un segundo escritor ni simular el gate productivo en otro puerto: el perfil exige `3201`.
3. En ventana aprobada, confirmar identidad del listener, detener **sólo** el preview identificado mediante su gestor, verificar `:3201` libre y arrancar el servicio dedicado con el artefacto, registro y política aprobados, en `127.0.0.1:3201`. Validar listener, health, login ADMIN con el mismo UUID y disponibilidad autenticada `#forward` sin reservar factura, depositar ni pagar. Informar resultado por gate, no dar por confirmado un swap. Si hay discrepancia o resultado incierto, cerrar admisión y reconciliar sin reintento; conservar todos los estados. Sólo si se confirma que no hubo mutaciones/intenciones y se autoriza la reversión, volver al preview read-only de `:3201`, nunca a `:3200`.

**Coordinación sin custodia:** el operador prepara el checklist, verifica referencias públicas, coteja evidencia saneada y coordina ventanas con el administrador. El custodio ejecuta los pasos privilegiados, transfiere privadamente el registro ADMIN sólo con autorización de custodia y hace la validación autenticada; devuelve coincidencia de identidad y resultados por gate, no UUID, hash, credenciales ni sesión. No se entrega al operador login de servicio ni ADMIN, `sudo`/`runuser`, sockets, llaves, cookies, macaroons, copia de auth store ni escritura sobre lanzadores, artefactos o estado. El operador puede verificar health público si existe; si falta evidencia de un gate, lo deja cerrado.
