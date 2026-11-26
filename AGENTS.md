# Swap Engine — guía para agentes

Basado en [C://GHOST Brain](https://github.com/c-ghost-project/c-ghost-brain) — José Dugarte | Dugui - Metodología C-GHOST.

- Lee `STATUS.md` al empezar. Si cambia el estado verificable de un hito, actualízalo al terminar. Mantén ese archivo en 100 líneas o menos.
- Trabaja exclusivamente en regtest para esta entrega. No reutilices volúmenes, wallets ni credenciales de otros laboratorios. No publiques `.env` reales, cookies, macaroons, claves ni datos privados del laboratorio.
- Antes de publicar, revisa `git diff --cached`, ejecuta `npm run secrets:check` y las pruebas pertinentes. Haz commits pequeños por hito validado y actualiza el mismo PR borrador. No hagas merge ni force-push.
- Separa compilación, pruebas automatizadas y evidencia regtest real. No declares un swap confirmado solo porque el proceso devolvió un TXID.

Esta adaptación usa memoria versionada y las verificaciones existentes del proyecto. No instala hooks ni cambia permisos del agente.
