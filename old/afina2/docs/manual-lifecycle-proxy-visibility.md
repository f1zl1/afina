# Unified manual lifecycle and bot proxy visibility

Schema remains **v13**. No new lifecycle authority, allocator or trading capability.

## Audit and changes

The existing Web START/STOP/RESTART buttons already called `bot.start`, `bot.stop`, and `bot.restart` through BotController → WebSocket API → InterfaceGateway → CommandService → LifecycleArbiter. The WebSocket server supplies the trusted Web actor; a request cannot choose an internal actor. No Web PAUSE or old orchestrator process control was found.

The remaining fallback was CommandService's generic mechanics handler when lifecycle authority was unavailable. External START/STOP/RESTART now fail with `LIFECYCLE_UNAVAILABLE` instead. Internal guarded commands and standalone test compatibility remain. No second adapter was added.

Manual actions retain ActionLedger bot/account ownership, workload drain, incarnation fencing and guarded BotManager mechanics. Normal STOP never implies force; the existing explicit `force:true` option remains separate. RESTART waits for old-process absence, releases its old reservation, then obtains a fresh allocation. An inactive previous proxy is excluded.

Manual START uses the same deterministic least-used/lowest-ID proxy allocator as autonomous START. `NO_ELIGIBLE_PROXY`, `PROXY_CAPACITY_EXHAUSTED` and unresolved ownership now survive ActionCoordinator error classification. An immediately failed manual action returns its blocker instead of reporting acceptance. Slow operations still return an accepted action identity and complete through the existing ledger.

The audit also found generic command logging could include `core.proxy.save` credentials. Proxy command payloads are now omitted from logs; focused coverage checks both credentials are absent from logs and responses.

## Bot representation and transport evidence

`bot.get` and `bots.get` now include backend-derived `proxy`, or `null` when no reservation is owned. ProxyStore supplies only proxy ID, label, host, port, protocol, active flag, reservation/incarnation state, safe transport evidence and bounded historical diagnostics. No username, password or authenticated URL is returned. BotStore preserves this object; the frontend does not join proxy tables.

The Ukrainian bot panel distinguishes:

- **Не призначено**: no owned reservation.
- **Зарезервовано для запуску**: RESERVED; no process/network claim.
- **Процес запущено через SOCKS5**: RUNNING reservation; no Minecraft login claim.
- **Вимкнений для нових запусків**: existing ownership continues.
- **SOCKS5 з’єднання встановлено**: only after successful socket creation and attachment.

The shared SOCKS connector emits a safe private IPC code with an opaque connection ID. BotProcess verifies the current child and incarnation. ProxyStore tracks at most eight live socket IDs per owned incarnation in memory; this accommodates a version probe alongside the main connection. Close/failure removes the socket, IPC loss and exit clear the evidence, and a replacement cannot inherit it. Safe bot-change events refresh the selected panel. There is no durable network-health state or schema change.

The Core proxy resource page retains its existing backend proxy-to-bot mapping. A retained reservation belonging to another incarnation is explicitly identified in the bot panel and cannot make the current bot appear connected.

## Production-path classification

| Path | Result |
|---|---|
| Web START/STOP/RESTART | LifecycleArbiter → ActionLedger → guarded BotManager; fail closed without authority. |
| Internal lifecycle start / replacement / binding continuation | Existing action authorization and mandatory pre-fork proxy reservation retained. |
| Configuration, Telegram binding and recovery restart requests | Inputs to LifecycleArbiter; no direct production restart loop. |
| BotManager legacy start/stop/restart branches | Standalone/internal test compatibility; Web commands cannot fall through to them. |
| Archive/account controls | Existing stopped-process restrictions and manual ownership takeover retained; no alternate Web spawn. |
| Ban/persistence safety stop and application shutdown | Existing explicit safety exceptions, not ordinary manual STOP. |
| BotProcess fork / Bot.start / Mineflayer | Real fork requires proxy authorization; shared SOCKS connector remains mandatory, without direct-IP fallback. |

Searches covered lifecycle method calls, BotManager/BotProcess, fork/spawn, commands, pause and orchestrator references. The sole production Mineflayer factory remains in `minecraftBot/bot.js`.

## Verification

Temporary databases and mocked worker/SOCKS transports only; browser smoke uses isolated Chrome and a mock API. Existing lifecycle fixtures were extracted into a shared test helper without removing their assertions.

| Run | Pass | Fail | Cancel | Skip | Duration |
|---|---:|---:|---:|---:|---:|
| New manual lifecycle/proxy tests | 12 | 0 | 0 | 0 | 1126.7828 ms |
| New + proxy + lifecycle + database-interface focused run | 118 | 0 | 0 | 0 | 13298.2099 ms |
| Final `npm test` | **537** | **0** | **0** | **0** | **55590.5013 ms** |
| Browser smoke | 1 scenario | 0 | 0 | 0 | 5.5924 s wall time |
| Syntax | 178 files | 0 | — | — | — |

One final full suite was run after implementation. Its coverage includes autonomous lifecycle, Analyst and manual Reseller regressions.

## Limits

No live proxy/Minecraft verification. Transport evidence proves the socket succeeded, not Minecraft authentication or lasting network health; it is lost on application restart. Historical diagnostics are labelled as history. Conservative PID-less reservation recovery and existing economic uncertainty rules are unchanged. Trading Intelligence remains outside scope.
