# Account history and quote amounts

The Account view reads the authenticated `GET /v1/reverse/availability`, `GET /v1/swaps`, and `GET /v1/ark/swaps` contracts. The reverse list is intersected with the owner's `preparedSwapIds`. Linked preparations collapse into the swap record, and repeated records use the latest revision or update time. A partial response identifies which source is unavailable. An Ark commitment TXID on a `SUBMITTED` record is pending confirmation.

Reviewed quotes can appear for the current signed-in page session and expire at their server deadlines. They clear on sign-out or reload. The backend remains the source for durable preparations and swaps. Guest activity stays in the active flow or encrypted recovery, using just the capability for that specific swap. The Account view never requests a Guest history list.

## Proposed durable history contract

An owner-scoped, paginated read model could include `entryId`, `kind`, `network`, `route`, `state`, `createdAt`, `updatedAt`, `expiresAt`, and nullable user-facing amounts for invoice or debit, service fee, claim fee, routing fee, and estimated net receipt. Include `quoteId`, `preparationId`, or `swapId` where the backend has the authoritative linkage. A stable `entryId` should survive retries and state changes. Derive ownership from the verified session and deduplicate linked quote, preparation and swap records server-side. Keep invoices, payment credentials, recovery material, idempotency keys and other owners' records out of that projection. Guest queries should remain limited to a single capability-bound record.

For new Lightning and Ark quotes, the entered amount must equal the returned `invoiceSats`. The service fee reduces it to `amountSats`, and the claim or network fee reduces that principal to the estimated net receipt. The provider funding reserve stays outside customer fees. `POST /v1/ark/swaps` still takes `quote.amountSats` as its `amountSats` payload field.
