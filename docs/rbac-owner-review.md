# Revisión defensiva de RBAC

Base revisada: `origin/main` en `c97be12`. Todas las pruebas emplean estado y adaptadores de prueba en loopback.

## Hallazgos

1. **El botón puede derivar un administrador autenticado al flujo Guest.** [La condición en quote.ts](../src/web/quote.ts#L294) permite Guest si el servicio de propietario se declara deshabilitado o inaccesible, o si no ofrece una preparación o un swap accesible. [app.ts](../src/web/app.ts#L33) obtiene la disponibilidad Guest por separado. La decisión debe distinguir una sesión explícitamente anónima de una sesión autenticada con acceso de propietario indisponible. Las rutas Guest tienen su propia autoridad por capacidad y quedan fuera de la sesión de propietario.
2. **Factura exacta y débito total requieren la misma garantía.** [La confirmación](../src/web/ownedReverse.ts#L280) muestra el importe de la factura como «Amount to send». [El plan vigente](../src/core/ReverseTestPlan.ts#L34) exige comisión de enrutamiento cero para el perfil de débito exacto y conserva un perfil histórico que admite hasta 100 sats de enrutamiento. Por inspección, el importe mostrado coincide con el débito del perfil vigente. La misma afirmación para una aprobación del perfil histórico exigiría impedir su admisión bajo una política de débito exacto o hacer explícito el máximo autorizado.
3. **La frontera de balances es el rol ADMIN.** [Operations](../src/api/server.ts#L207) comprueba el rol antes de invocar el colector y devuelve el resultado con `Cache-Control: no-store`. Alice y Provider quedan privados frente a invitados y USER. El endpoint aplica la misma autorización a todos los administradores. Si la política exige la cuenta de operador específica, falta exigir su identidad allí.
4. **Los swaps propios están ligados al propietario de la sesión y a controles de escritura.** [La asociación](../src/api/ownedReverse.ts#L70) vincula el ID de cuenta al swap y al contrato. [El gateway](../src/api/ownedReverse.ts#L198) exige origen y CSRF para mutaciones. [La admisión](../src/api/ownedReverse.ts#L95) vincula la clave al propietario, swap, acción y revisión, y guarda la intención antes de ejecutar. [La UI](../src/web/ownedReverse.ts#L211) vuelve a verificar los términos revisados y conserva la clave antes de enviar.

## Pruebas

`tests/rbacReview.test.ts` monta la API real con sesiones generadas, un swap ligado a un propietario y balances sintéticos. Cubre lectura del dueño, privacidad ante otro administrador, denegación de balances anónima y USER antes del colector, respuesta privada ADMIN, y rechazo de mutación por CSRF, origen o falta de idempotencia sin registrar una intención.

`tests/ownedReverseApi.test.ts` y `tests/browser/ownedReverse.integration.test.ts` prueban el envío repetido y la reconciliación con ejecutores simulados. Los hallazgos de navegación Guest y comisión histórica proceden de inspección del código. Esta rama agrega revisión y pruebas, y no toca cotización, preparación ni habilitación de fondos.
