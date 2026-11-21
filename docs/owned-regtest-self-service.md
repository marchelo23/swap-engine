# SWAP regtest para truja503

Solo el ADMIN `truja503` y su UUID configurado pueden preparar/ejecutar. Alice LND paga; su dirección on-chain existente recibe. Core `lqwd-lab` financia y conserva el cambio; LND Provider cobra. Guest y mainnet siguen cerrados. El servicio se activa exclusivamente con:

```text
node --env-file=REGTEST_ENV --import tsx src/main.ts --owned-regtest --policy-path ABS --policy-sha256 SHA256
```

La política privada se valida con `ownedRuntimePolicySchema`: owner/UUID/store de cuentas existentes, origen exacto `http://127.0.0.1:3101`, identidades/endpoints loopback, canal/outpoint fijo, dirección externa Alice y refund/change del proveedor, rutas de credenciales limitadas, password cifrado local, directorios privados separados de runs/backups y opcionalmente archivos de runs COMPLETED verificados. No se aceptan estos datos desde HTTP. `maxInputSats` limita la selección determinista de un UTXO P2WPKH confirmado, seguro, desbloqueado, no coinbase y wallet-owned; el input elegido queda ligado a cada spec/plan. Los límites admitidos son principal 50000, invoice 50750, claim 500, funding 1000, routing 100 y hasta dos bloques.

Preflight real sin crear keys/factura ni ejecutar pagos:

```text
node --import tsx scripts/check-owned-runtime.ts --check-owned-runtime --policy-path ABS --policy-sha256 SHA256
```

Comprueba NTP, chain/height/identidades, canal directo y liquidez en dirección Alice→Provider, pertenencia del destino Alice, roles de macaroons y wallet regtest. La preparación vuelve a comprobarlos. Con NTP/prerrequisitos inválidos antes de invocar el harness se registra REJECTED sin factura; permite solamente otro SWAP explícito con una clave nueva. Cualquier fallo después de poder haber creado factura queda UNKNOWN y conserva su reserva hasta reconciliarse.

Contrato HTTP, con la misma cookie Sessions, origen y CSRF del login existente:

- `GET /v1/reverse/availability` añade `preparationAvailable` y `preparations`.
- `POST /v1/reverse/preparations`, `{amountSats:50000}`, `Idempotency-Key`, `X-CSRF-Token`: admisión durable antes de custodia/factura; devuelve 202 con `{id,status,swapId,statusUrl}`. No paga ni firma.
- `GET /v1/reverse/preparations/:id`: INTENT → READY, UNKNOWN, REJECTED, COMPLETED o EXPIRED. El owner no puede cambiar input, destino, fees, red o roles.
- `POST /v1/reverse/preparations/:id/review`, `{}`, clave propia y CSRF: revalida únicamente la misma factura no usada tras expiración/reinicio. No recrea la factura ni repite ejecución. Una aprobación aún válida nunca amplía su plazo por replay.
- Revisión de UI → Start explícito conserva `POST /v1/swaps/reverse` con `{preparedSwapId,expectedRevision}`, clave de ejecución durable y CSRF. Ventana JIT de hasta 10 minutos y ejecución de 90 segundos con guard monotónico.

SWAP vuelve a preparar otro intento después de COMPLETED verificado o EXPIRED reconciliado, sin botón «Hacer otro». Cada ciclo tiene nueva clave de admisión, ID/hash y custodia; historial previo permanece accesible. No hay creación/pago automático al arrancar, recargar, consultar status o terminar otro swap. Repetir una clave devuelve el mismo intento. INTENT/UNKNOWN y ejecución incierta bloquean nuevas preparaciones. Reinicio recupera por lookup y monta status sin autoridad de ejecución; una revisión explícita vuelve a verificar la factura/ausencia de pago antes de habilitar el mismo plan.

Tras COMPLETED autoritativo con pago SUCCEEDED y ambos txids, la UI guarda evidencia pública, limpia solo las claves del owner/intento terminado y vuelve a SWAP con foco. Un reload antes de recibir la respuesta también reconcilia ese estado; otras claves e historial sobreviven. Una revisión con respuesta perdida conserva su clave INTENT hasta evidencia autoritativa; no genera otra por repetir SWAP. Cambiar de vista durante preparación/revisión impide navegación o modal tardíos.

Limitación conservadora: si la preparación queda UNKNOWN sin runtime montado, se requiere lookup/reinicio controlado para restaurarla; nunca se sustituye por otra factura. Un lock huérfano o una evidencia de recuperación no soportada requieren revisión del operador. Los fallos antes de invocar el harness de factura se distinguen como REJECTED; permiten otro intento explícito sin reusar ni sobrescribir custodia parcial.

El writer de creación debe ser el mismo archivo de credencial invoices-only inspeccionado para Provider. La ausencia de pago exige una página completa con hashes/índices y offsets coherentes; páginas de 100 registros, truncadas o incompatibles se rechazan sin otorgar nueva autoridad ni liberar la reserva.

Los archivos COMPLETED no bastan si la VM/cadena retrocedió: montaje y preflight verifican el checkpoint real de `chainObservations`, funding/claim confirmados en cadena activa y witness criptográfico con recepción exacta. Los intents de minería del runner pueden no tener `blockHash`; no se inventa ese dato. Un fork o snapshot incompatible cierra el gateway; no se arregla simplemente creando bloques nuevos. Los tests usan temporales privados y canónicos para no confundir permisos de un checkout compartido con permisos válidos de custodia; los guards de producción permanecen estrictos.

Custodia: claves nuevas cifradas y backup restaurado antes de la factura; copias locales en la misma VM no son independientes físicamente. Secretos solo servidor, nunca en JSON público, URL, stdout, navegador ni Git. Un único catalog Store serializa admisiones; cada run mantiene su propio writer y action intents. Cierre espera al journaling antes de liberar locks; no se borran locks huérfanos automáticamente. Los runs históricos configurados solo admiten lectura/replay de resultados, nunca nueva autoridad.

El servicio systemd conserva loopback, `Restart=no`, `NoNewPrivileges`, `ProtectSystem=strict` y `ProtectHome=read-only`; solo app-data, directorios de runs/backups y stores históricos configurados deben ser escribibles. `ENABLE_LIVE_SWAPS=false` permanece obligatorio. No desplegar sobre cuentas, vaults ni datos existentes; usar release separado y detener únicamente 3101 después de comprobar que no hay ejecución activa.
