# Proxy & Credential Resource Management v1

Implemented 2026-09-26 on Core v2. Schema **v13**. No new lifecycle controller or bot scheduler. Autonomous trading remains disabled.

## Architecture and ownership

The audited production path is:

`Core START/REPLACE → ActionLedger ownership → LifecycleArbiter.authorize → BotManager guarded start → LifecycleArbiter.beforeSpawn → durable proxy reservation → BotProcess fork → private worker init → Bot.start → SOCKS5 socket → minecraft-protocol/Mineflayer`.

`ProxyStore` is a resource store called by the existing lifecycle owner. It does not schedule, restart or stop bots. The old unused `ProxyPool` stub and its main-module export were removed. Account generation still creates credentials without reserving network capacity; every subsequent worker start, including replacement and binding continuation, crosses the same pre-spawn hook.

Reservations deliberately outlive ActionLedger action completion: a completed START still owns a running process. The reservation records the action ID, bot ID and incarnation rather than making a long-lived proxy slot an action-scoped resource that would be freed on completion. Existing bot/account ActionLedger exclusivity remains unchanged.

## Schema and canonical policy

v13 adds:

- `proxies`: ID, label, host, port, SOCKS5 protocol, username/password, active flag and timestamps.
- `proxyReservations`: reservation ID, proxy FK, bot/action/incarnation identity, RESERVED/RUNNING/RELEASED state, PID, timestamps and release reason. A partial unique index prohibits two owned reservations for one bot.
- `proxyDiagnostics`: one bounded, allowlisted latest transport diagnostic per proxy.
- `telegramAccounts.active`: constrained 0/1, default 1, preserving existing accounts and bindings.

`operationsPolicy.maximumBotsPerProxy` is the only capacity setting: default **4**, integer **1–1000**, identical for all proxies. It uses the existing canonical policy validation, revision and update command. Older policy documents receive the default when read; there is no per-proxy capacity override.

Migration uses the existing complete SQLite backup, transaction, FK/integrity checks and receipt machinery. Both fresh initialization and v12 upgrade record v13. Tests cover rollback after a failed upgrade, repair/retry and idempotent reopen. Existing older migration fixtures were adjusted to remove v13 additions when constructing older schemas and to expect the current final version; their original assertions remain.

## Reservation and allocation rules

1. Lifecycle authorizes the bot/action before allocation. A validated active proxy is selected inside `BEGIN IMMEDIATE` using lowest owned count, then lowest proxy ID. RESERVED and RUNNING both consume capacity.
2. The durable reservation commits before fork. Existing unresolved bot ownership blocks replacement overlap. Concurrent reservations cannot consume the same final capacity slot.
3. PID is persisted after fork; the spawn event confirms RUNNING. Credentials are sent only in private initialization IPC. A real BotProcess fork without a proxy fails with `AUTHORIZED_PROXY_REQUIRED`; the worker connection layer independently requires matching reservation/incarnation identity.
4. Fork failure before child ownership releases its reservation. A child exit releases the captured incarnation, including during shutdown. IPC disconnect, heartbeat loss, workload drain, action completion and timeout do not release capacity.
5. Startup and normal Core reconciliation use OS process-existence evidence for persisted PIDs. Only proven absence releases a reservation. Unknown probe results and PID reuse retain ownership conservatively. A stale incarnation cannot release a replacement's allocation.

No eligible active proxy produces `NO_ELIGIBLE_PROXY`; full active proxies produce `PROXY_CAPACITY_EXHAUSTED`; unresolved old bot ownership produces `PROXY_OWNERSHIP_UNRESOLVED`. There is no direct-IP fallback. Capacity failure does not introduce a proxy retry loop: existing lifecycle recovery/backoff remains authoritative.

Deactivation stops new allocation only. Existing owners continue until lifecycle termination. Restart/replacement then selects an eligible active proxy. Lowering the capacity preserves existing owners, reports over-capacity, and blocks additional allocation until usage drops. No live socket migration is attempted.

Endpoint/protocol/credential edits and deletion are blocked while owned; label and active-state edits remain available. Deleting an unused proxy removes its released reservation history and diagnostic, then the proxy. The FK prevents orphaning an owned allocation. Retain an external audit copy before deleting if that history is needed.

## Transport and secrets

`src/minecraftBot/worker/proxyTransport.js` supplies Mineflayer's `connect` callback using the installed `socks` package, now an explicit dependency. It establishes SOCKS5 TCP to the configured Minecraft host/port, attaches the resulting socket with `client.setSocket`, and emits protocol connect. The server hostname is passed to SOCKS5; no direct Minecraft TCP connector or fallback is installed.

The local installed `minecraft-protocol` sources were inspected: `client/tcp_dns.js` retains a supplied callback instead of installing its direct connector; `createClient.js` and `ping.js` use that callback, including version probing. All roles share `Bot.start`; no role-specific proxy routing exists.

Host, port, protocol, label and credential lengths/control characters are validated server-side. Authenticated URLs are not accepted as hosts. Username/password must be supplied together. Ordinary snapshots and save responses omit both credential values and expose only `hasCredentials`; proxy tables are not exposed through the generic database editor. Worker Bot holds configuration in private fields. Credentials never enter worker facts, general public events, lifecycle metadata or proxy diagnostics.

Third-party SOCKS errors are reduced to bounded codes before forwarding: `PROXY_AUTHENTICATION_FAILED`, `PROXY_CONNECTION_FAILED`, or `PROXY_TRANSPORT_FAILED`. Minecraft rejection remains the existing Minecraft/lifecycle event; it does not mark a proxy bad. A failed connection does not deactivate the proxy or claim permanent unreachability. No authenticated proxy URL is constructed or logged.

Credentials are stored in the local SQLite database and travel over local worker IPC; encryption at rest and a vault are outside this milestone. Protect the database, backups and host access accordingly.

## Telegram administrative state

The production allocation chain remains `TelegramManager.handleMinecraft(binding) → TelegramAccountPool.acquireForMinecraftAccount → TelegramAccountStore.assign`.

The transactional selector now requires `active=1` in addition to connected/session/capacity eligibility. An existing assignment to an inactive account cannot initiate a new binding operation. No available candidate returns the existing explicit `telegram:noAvailableAccount` error. Existing relationships remain intact; login confirmation for an existing relationship and already-started binding operations retain their existing safety contract. The new regression verifies deactivation during binding still permits correlated completion, while the next new binding cannot select that account.

`telegram.setActive` requires a Web operator and validates a boolean. Deactivation does not delete the session, disconnect the client, mark it banned, or cancel pending work. Reactivation restores allocation eligibility subject to existing connection/capacity checks. Pool free-capacity diagnostics exclude inactive accounts. Generic database mutation already treats `accountsData.telegramAccountId` as read-only, so it cannot bypass this selector.

## Startup, shutdown and observation

Proxy reconciliation runs before Core startup admission and during evaluation. The existing `await core.start()` before Web initialization is preserved. Reservation data distinguishes configured proxies, pre-spawn reservations and spawn-confirmed process ownership; RUNNING does not mean Minecraft authentication succeeded or that the network remains reachable.

Inactive proxies retain existing reservations. Missing/deleted proxies cannot normally occur under the FK and guarded deletion path. Interrupted STOP or replacement retains the old slot until process exit/absence. Interrupted START with a persisted PID reconciles using OS evidence. Old-incarnation ownership remains held while its PID may still exist, even if a different current process is observed.

**Conservative crash window:** a parent crash between committing a reservation and persisting its child PID leaves a PID-less RESERVED row. This cannot safely be auto-released: a child might have been created. The UI exposes the reservation and the bot remains blocked. Recovery requires offline operator reconciliation after independently proving all relevant workers stopped, with a database backup before repairing the ownership record. There is intentionally no unsafe “release capacity” button based on a timeout. PID reuse or inaccessible OS evidence can also retain capacity unnecessarily.

Core shutdown closes admission; captured child-exit callbacks still release proven-ended proxy ownership. Uncertain economic transactions keep their established Core v2 semantics independently of proxy release.

## Ukrainian Web UI

The Core proxy section provides manual create/edit, activate/deactivate and safe delete, plus the global “Максимум ботів на один проксі” setting. Password inputs are cleared on submission and never populated from stored data. Leaving both credential fields blank while editing preserves them; the API also accepts an explicit empty pair to remove credentials on an unused proxy.

Rows show label, host, port, SOCKS5, administrative/capacity status, bot/reservation mapping, used/available capacity, over-capacity and latest bounded diagnostic. Inactive owned proxies remain visibly in use. Capacity and blockers come from the backend, not a frontend allocation calculation. Diagnostics explicitly avoid claiming measured network health.

Telegram rows show active/inactive allocation semantics and Ukrainian activation buttons, separately from authorization/connection state.

## Production connection-path audit

Searches covered `createBot`, `createClient`, `connect`, `net.connect`, `Socket`, `minecraft-protocol`, proxy fields and server destination plumbing.

| Finding | Classification |
|---|---|
| `src/minecraftBot/bot.js: mineflayer.createBot` | Only production Minecraft creation; mandatory supplied SOCKS5 callback. |
| `proxyTransport.js: SocksClient.createConnection` | Only added TCP transport; destination is reached through SOCKS5, no fallback. |
| `BotManager → BotProcess → botWorker.initialize` | Existing guarded spawn path; private reservation/configuration passed through it. |
| `src/webTerminal/public/app.js` / `botController.createBot` | UI definition creation, not a Minecraft connection. |
| Telegram MTProto client | Telegram service connection, outside Minecraft transport scope; allocation active-state checks are in its binding caller. |
| `tests/movementPacketTrace.test.js` protocol Client import | Packet-trace fixture, not a production connection factory. |
| Old ProxyPool stub | Removed; no second allocator or misleading zero-capacity implementation remains. |

Telegram assignment writes were traced to `TelegramAccountStore.assign`; the public pool delegates to it. Reauthorization preserves account identity and active state. Core/account generation and replacement regression coverage verifies existing ownership/idempotency remains intact.

## Deployment and verification

Stop the previous application and verify all old workers are gone before upgrading; an already-connected old direct socket cannot be converted to SOCKS5. Back up the complete database/configuration and previous binary. Verify the configured database path, upgrade on a temporary copy, then inspect v13 receipt, FK check and integrity check. Add active proxies from the Web UI before starting bots; a fresh database intentionally has zero proxy capacity. Check the canonical limit and resource mapping after a small manual start. Rollback requires stopping all workers and restoring the matching pre-upgrade database and binary, not downgrading schema in place.

Tests used temporary databases and mocked process/Minecraft/SOCKS transports. The configured production database was not opened or changed. Browser testing used an isolated Chrome profile and mock API.

| Verification | Passed | Failed | Cancelled | Skipped | Duration |
|---|---:|---:|---:|---:|---:|
| Final `proxyResources.test.js` | 41 | 0 | 0 | 0 | 1219.6073 ms |
| Proxy + lifecycle focused run¹ | 104 | 0 | 0 | 0 | 11518.8527 ms |
| Relevant regressions² | 293 | 0 | 0 | 0 | 34693.8551 ms |
| Final `npm test` | **525** | **0** | **0** | **0** | **50477.5738 ms** |
| `npm run test:ui` | 1 browser scenario | 0 | 0 | 0 | 4.9516 s wall time |
| Syntax (`node --check`) | 176 files | 0 | — | — | — |

¹ Included 40 proxy cases at that point plus 64 lifecycle cases; the final fresh-v13 receipt assertion is included in 41/525 above.

² Telegram (including in-flight deactivation), actions, scheduling, policy authority, workloads, economics, Analyst/market, operational account generation, account generation, automation, incidents, storage migrations and Phase 8 completion tests. New focused cases cover CRUD, validation/redaction, capacity boundary/race, deterministic distribution, active state, failed spawn, IPC loss, exit/absence, stale incarnation, replacement overlap, SOCKS success/authentication failure, diagnostics, migration rollback/reopen and production-path guards. Existing Core v2 assertions were retained; lifecycle fixtures now provision explicit mock proxies.

Browser smoke covers proxy creation/password clearing/deactivation/deletion and Telegram activation, alongside existing Core/economic/Analyst views. One mock initially mutated a shared response object and suppressed UI refresh; immutable mock responses fixed that fixture issue. An earlier development regression run without provisioned proxy fixtures was interrupted after its expected failures; the final focused and full runs above are complete. Exactly one final full suite was run.

## Result and limitations

The managed production invariant is now **authorized active proxy reservation before guarded spawn, then SOCKS5 before Minecraft**. No proxy capacity means no new process start; inactive resources receive no new allocation. Existing Core lifecycle, action and account ownership remains authoritative.

No real proxy, live Minecraft or live Telegram verification was performed. No proxy health/quarantine service, automatic proxy failover loop, live socket migration, encrypted credential vault, or Trading Intelligence was added. PID-less crash reservations require conservative offline recovery; retained/reused PIDs may reduce available capacity. SOCKS5 failures use bounded library-error classification; diagnostics do not prove long-term reachability. Existing servers must remain compatible with the configured host/version/port and SOCKS5 service.
