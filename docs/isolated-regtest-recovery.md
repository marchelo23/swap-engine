# Recovery after an unclean host restart

Use this only for the `swap-engine-iso-regtest` Podman Compose project.
Do not reset Bitcoin, Elements, LND, Ark, or Postgres state to repair an index.

If Fulcrum reports `Failed to rewind: Unable to retrieve undo info` and
restarts repeatedly, stop `iso_rt_fulcrum`, verify that its data mount is
`iso_rt_fulcrum_data`, and move the contents of that volume's `_data`
directory to a private sibling backup. Start only `iso_rt_fulcrum` and let it
reindex from the isolated Bitcoin Core chain. Leave the mount directory and
its ownership intact.

If Mempool still reports an old tip after Fulcrum is ready, stop
`iso_rt_mempool_api` and repeat the same backup procedure only for
`iso_rt_mempool_cache`. Use `podman unshare` for the move when files are owned
by a mapped container UID. Start `iso_rt_mempool_api` again.

Before proceeding, require Esplora's tip height and hash to match Core and
NBXplorer to report full synchronization at that height. A running container
or Mempool's own “in sync” log is not sufficient.

An unclean restart can also leave LND ahead of Core. If LND repeatedly
reports `Block height out of range`, compare the recovered Core height to
the pre-restart index height. In this disposable regtest lab, with no
swaps attempted, mining above the old height let LND resynchronize without
resetting its wallets. Recheck full sync, Core/LND tip equality and the
active channel on both nodes. If a swap or channel funding may be on the
lost branch, reconcile its exact outpoints before mining or retrying it.

The pinned LND v0.20.8-beta does not return `wallet_synced` from GetInfo.
Its [GetInfo implementation](https://github.com/lightningnetwork/lnd/blob/33f90e82464daf9e6d2f2a02e754955ba42e2951/rpcserver.go)
computes `synced_to_chain` from `Wallet.IsSynced()` plus other sync checks.
Read-only preflight accepts that signal only for the known version and commit
when `wallet_synced` is absent. An explicit `false`, an unidentified build
without the field, or an unsynchronized node still blocks wallet readiness.
The server-state and exact Core tip checks remain independent. This is
diagnostic evidence only; it does not change execution guards.

For arkd v0.9.25, Compose expiry settings only seed a new database. The
bootstrap checks the effective `vtxoTreeExpiry` through the isolated admin
API and updates it if needed. The update does not change the expiry of
existing VTXOs. A recoverable balance is not evidence of a spendable VTXO.
