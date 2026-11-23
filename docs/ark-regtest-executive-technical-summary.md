# Arkade en Swap Engine: resumen ejecutivo y técnico

**Alcance:** [épica #46](https://github.com/Truja503/swap-engine/issues/46), serie de PR #56–#64 y entrega web #69. El estado de `main` descrito aquí corresponde a `b10e4a7`, tras el PR #71. Este documento resume evidencia publicada; no representa una nueva ejecución.

## Resumen ejecutivo

La entrega demuestra que **Bitcoin puede entrar a Arkade, transferirse entre dos wallets Ark y volver a Bitcoin mediante una salida cooperativa**, todo en una red Bitcoin regtest controlada. La prueba no usa fondos reales ni los servicios Bitcoin Core y LND del motor. El resultado importante no es que una solicitud devuelva éxito: se verificaron los importes, los cambios de saldo y, cuando correspondía, la salida exacta en la cadena de prueba.

El trabajo produjo tres entregables distintos:

1. **Laboratorio reproducible:** operador Arkade, nodo Bitcoin propio, dos wallets persistentes y pruebas de depósito, transferencia, retirada y recuperación. Está en una serie de nueve PR abiertos.
2. **Contrato de integración:** un adaptador Rust con lecturas reales para comprobar conectividad, saldo, VTXOs y política de comisiones. El contrato describe cómo deberían funcionar las escrituras futuras, pero el adaptador no las ejecuta.
3. **Experiencia web:** el #69, ya fusionado, hizo visible Ark como opción de regtest sin habilitar swaps. Posteriormente, el #71 integró telemetría de solo lectura y una vista previa Ark/Bitcoin bajo perfiles de entorno verificados. La presencia de controles, estimaciones o código de preparación no equivale a ejecución financiera habilitada.

**Decisión recomendada:** revisar el laboratorio como entrega de validación de Arkade en regtest. Mantener deshabilitada la ejecución financiera de Ark en el motor hasta demostrar, por separado, la correspondencia entre cotización, importe, destino y liquidación. Ark ↔ Lightning no está implementado ni validado por esta serie.

## Arquitectura y decisiones

| Decisión | Implementación | Motivo y contrapartida |
| --- | --- | --- |
| Separar Ark del motor | Workspace Rust en `ark/`, configuración en `deploy/ark/` y scripts en `scripts/ark/`. El motor principal sigue en TypeScript. | Permite validar el protocolo sin cambiar la máquina de estados de swaps. A cambio, el laboratorio tiene su propio toolchain y ciclo de pruebas. |
| Fijar una combinación conocida | SDK oficial `arkade-os/rust-sdk v0.12.1` fijado por commit, `arkd v0.9.25` y Bitcoin Core `31.0`. | Se eligió la versión de `arkd` usada en las pruebas del SDK, no simplemente la más reciente disponible al diseñar el lab. Las actualizaciones requieren volver a comprobar compatibilidad. |
| Usar infraestructura dedicada | `arkd`, firmante y wallet del operador separados, con indexadores y almacenamiento del lab. La corrida E2E final tuvo red interna, volúmenes propios y ningún puerto publicado al host. | Reiniciar servicios, minar bloques o probar fallos no debe afectar al Core o LND del motor. Regtest permite controlar la cadena, pero no reproduce las condiciones ni la economía de mainnet. |
| Separar identidades y estado | Alice y Bob conservan identidades BIP39 y contratos locales del SDK. SQLite conserva los contratos del cliente; el historial de VTXOs se consulta al operador, no a una caché local de balances. | Permite distinguir remitente, destinatario y cambio, y comprobar restauración. Si el operador no responde, no se sustituye la lectura por saldo cero. |
| Separar observación de ejecución | El adaptador Rust implementa `balance()`, `vtxos()` y `fee_policy()`. El CLI del lab ejecuta los flujos de prueba por separado. | Una consulta exitosa no acredita que el motor pueda firmar, liquidar y recuperarse correctamente ante fallos. |

### Cómo se comprobó el flujo de fondos

Un **UTXO** es una salida no gastada en Bitcoin; un **VTXO** es una salida virtual en Ark. El VTXO tiene su propio identificador y estado, y su presencia en el índice de Ark no equivale a un pago confirmado en Bitcoin.

1. **Boarding (Bitcoin → Ark).** Bitcoin Core confirma el fondeo de una dirección de depósito de Alice. El SDK incorpora esa salida al lote de Ark; se correlacionan el UTXO fondeado, el compromiso en Bitcoin y el VTXO acreditado. Así se distingue un depósito detectado de un depósito convertido efectivamente en saldo Ark.
2. **Transferencia Ark (Alice → Bob).** Se verifica que el VTXO de entrada de Alice se consumió y que Bob recibió un VTXO por el importe previsto, con el cambio correcto para Alice. Se comprueba que la transferencia dejó de estar pendiente. Su preconfirmación es **off-chain**; que un compromiso ancestro esté minado no convierte ese envío en una transacción Bitcoin confirmada.
3. **Offboarding cooperativo (Ark → Bitcoin).** Antes de pedir la salida, se valida que el VTXO sea apto. Luego se comprueba en Core la salida concreta, su script de destino, su valor y su confirmación. Un TXID devuelto por el operador no basta por sí solo. Se verificó el rechazo de entradas consumidas o expiradas/recuperables antes de mutar.
4. **Recuperación y persistencia.** Se probó la renovación de un VTXO expirado y se compararon balances y estado relevante antes y después del reinicio. Renovar un VTXO no es una salida unilateral ni demuestra que el sistema se recupere de cualquier fallo de red.

### Adaptador: qué lee y qué deja pendiente

| Capacidad del adaptador Rust | Estado y semántica |
| --- | --- |
| `balance()` | Lectura real del operador para una identidad de wallet. El total no equivale a saldo gastable: incluye categorías como fondos recuperables o pendientes de recuperación. |
| `vtxos()` | Lectura real de historial, incluido lo ya gastado. Expone identificadores, importes, expiración y compromisos. No es una interfaz paginada de producción. |
| `fee_policy()` | Lectura real de `GetInfo`: política anunciada, límites y umbral de polvo, entre otros datos. Si el operador no anuncia política, eso no implica costo cero. |
| `quote()`, `submit()`, `status()`, `proof()`, `recover()` | Contrato propuesto; devuelven `UnsupportedCapability` en el adaptador de lectura. No se reutiliza el CLI como ejecutor de una API financiera. |

El contrato distingue **preparado**, **enviado**, **preconfirmado**, **confirmado** e **incierto**. Por ejemplo, un intento encontrado como preparado tras una caída pudo llegar al operador; reenviarlo a ciegas puede duplicar la operación. La recuperación propuesta debe reconciliar el intento original. Del mismo modo, una confirmación observada en la cadena activa puede perderse en una reorganización: la prueba debe conservar bloque, altura y profundidad observada, no tratar la confirmación como irreversible.

## Orden de revisión y qué aporta cada PR

La serie es acumulativa. Como todos estos PR apuntan a `main`, la vista de archivos de un PR posterior incluye capas anteriores. Para revisar solo lo nuevo de cada capa, compárala con su predecesora. Algunas descripciones conservan un orden antiguo: prevalece la cabecera actualizada y la cadena de commits documentada en el #64.

| Orden | PR | Entrega y criterio de revisión |
| --- | --- | --- |
| 1 | [#56](https://github.com/Truja503/swap-engine/pull/56) | Arquitectura, matriz de compatibilidad y plan. Define qué se aísla, qué versiones se usan y qué no cambia en el motor. |
| 2 | [#59](https://github.com/Truja503/swap-engine/pull/59) | Operador: Compose, arranque, salud y apagado. Revisar que las dependencias y datos de prueba estén separados. |
| 3 | [#58](https://github.com/Truja503/swap-engine/pull/58) | Wallets persistentes A/B. Revisar que reinicializar no cambie identidades y que los datos privados queden fuera de Git. |
| 4 | [#57](https://github.com/Truja503/swap-engine/pull/57) | Boarding. Revisar el vínculo entre fondeo confirmado, lote y valor acreditado en Ark. |
| 5 | [#60](https://github.com/Truja503/swap-engine/pull/60) | Transferencia y recuperación. Revisar consumo de entrada, recepción, cambio y tratamiento de resultados inciertos. |
| 6 | [#62](https://github.com/Truja503/swap-engine/pull/62) | Offboarding cooperativo. Revisar elegibilidad antes de mutar y evidencia de la salida en Core. |
| 7 | [#61](https://github.com/Truja503/swap-engine/pull/61) | Pruebas contenerizadas, runbook y workflows separados. Revisar que la publicación se bloquee si falta un JSON permitido, aparece un archivo inesperado o falla el esquema. |
| 8 | [#63](https://github.com/Truja503/swap-engine/pull/63) | Contrato Rust, lecturas contra el operador y correcciones de revisión. Restablece verificaciones regtest y cobertura de arranque y persistencia. |
| 9 | [#64](https://github.com/Truja503/swap-engine/pull/64) | Informe, PDF y capturas. La última capa añade documentación y conserva la atribución de las corridas por fase y commit. |

## Evidencia y lectura de resultados

La corrida final del laboratorio se documentó sobre `ba319b35423a16ac2bf07b8123be1f1e6806bcfc`, con Podman local. La matriz registró **10 etapas en vivo aprobadas y 2 omitidas**. La prueba de lectura real contra `arkd` pasó por separado; el control de reinicio comprobó seis invariantes y el validador aceptó los seis JSON previstos.

| Paso | Resultado observado en regtest |
| --- | --- |
| Fondeo y boarding | Fondeo de **200 000 sats** en el bloque **103**; compromiso confirmado en el **104**; Alice recibió **200 000 sats** en Ark. |
| Transferencia | Bob recibió **75 000 sats** y Alice conservó **125 000 sats**. Resultado preconfirmado fuera de cadena. |
| Offboarding cooperativo | Bob recibió **30 000 sats** en una salida de Bitcoin en el bloque **105** y conservó **45 000 sats** en Ark. |
| Renovación | Alice renovó un VTXO de **125 000 sats** en el bloque **106** sin cambiar su saldo en la corrida. |
| Controles negativos | El retiro rechazó VTXOs consumidos y expirados/recuperables antes de mutar. La evidencia se validó antes de empaquetarse para publicación. |

Se midieron, entre otros, **262 sats** de comisión de cadena en el compromiso de boarding y **241 sats** en el retiro. Son observaciones de ese entorno, **no tarifas garantizadas**. La comisión de cadena y la comisión cobrada al usuario son conceptos distintos; un cargo de usuario en cero en un fixture no implica una operación gratuita en producción.

**Lo no demostrado:** salida unilateral, timeout real durante una mutación (solo simulación unitaria), ejecución de esta matriz con Docker Engine y Compose v2 nativos o en GitHub Actions remoto, mainnet, ni swaps financieros Ark desde la aplicación. Las pruebas del laboratorio tampoco acreditan un swap Lightning → Bitcoin ni el funcionamiento de las rutas web o de administración.

## Qué está en `main` y qué sigue

- **[#69 — interfaz inicial](https://github.com/Truja503/swap-engine/pull/69):** integró Ark en el selector con la marca Arkade, indicación de regtest y aviso de que no había swaps Ark disponibles. La sección de administración se presentó como informativa. Esta es la entrega web original, no el resultado del laboratorio.
- **[#70](https://github.com/Truja503/swap-engine/pull/70) y [#71](https://github.com/Truja503/swap-engine/pull/71) — integración posterior:** los perfiles de entorno y la integración de telemetría permiten observar un operador Ark regtest y una vista previa del par Ark/Bitcoin. El módulo TypeScript `src/ark/ArkAdapter.ts` pertenece a esta integración del motor y no es el contrato Rust `ark/ark-lab/src/adapter.rs` del #63. El #71 conserva las escrituras Ark deshabilitadas y no incorpora un adaptador directo Ark ↔ Lightning. Sus pruebas de aplicación y navegador son evidencia separada de la corrida del laboratorio.
- **Antes de habilitar escrituras:** volver a ejecutar el laboratorio sobre los commits que se vayan a integrar, contrastar resultados en el entorno CI objetivo y demostrar conciliación ante reintentos, reinicios y estados inciertos. Para habilitar un flujo financiero en el motor, verificar independientemente que el importe, destino y liquidación coinciden con lo cotizado. Ark ↔ Lightning requeriría diseño y pruebas propios.

## Fuentes

- [Arquitectura del laboratorio](https://github.com/marchelo23/swap-engine/blob/439607d1ac670424bbc8688d257115b5d7109ef7/docs/ark/architecture.md) y [matriz de compatibilidad](https://github.com/marchelo23/swap-engine/blob/439607d1ac670424bbc8688d257115b5d7109ef7/docs/ark/compatibility.md).
- [Contrato Rust del adaptador](https://github.com/marchelo23/swap-engine/blob/439607d1ac670424bbc8688d257115b5d7109ef7/docs/ark/ark-adapter.md).
- [Evidencia E2E en Markdown](https://github.com/marchelo23/swap-engine/blob/439607d1ac670424bbc8688d257115b5d7109ef7/docs/ark/docker-e2e-evidence.md), con TXIDs, alturas, resultados y trazabilidad por commit, e [informe PDF en español](https://github.com/marchelo23/swap-engine/blob/439607d1ac670424bbc8688d257115b5d7109ef7/docs/ark/evidence/docker-e2e/ark-docker-e2e-report-es.pdf).
