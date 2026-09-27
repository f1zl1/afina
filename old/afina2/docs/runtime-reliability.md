# Runtime reliability: realm stabilization and shared Anti-AFK

See [FunTime runtime incidents and Core test-account replacement](runtime-incidents.md)
for the v7 extension, operational inventory blocking and persisted ban handling.
The v6 behavior documented below remains the preventive/recovery baseline.

This extension uses the existing Bot → BotProcess → BotManager lifecycle and worker event bridge. It does not add a supervisor, change economic decisions, or enable autonomous trading.

## Configuration and application

SQLite migration **v6** adds nine persisted columns to the existing `corePolicy` singleton. Upgrades retain existing data and create the existing migration backup. The Core policy command validates types, ranges, interval ordering and optimistic revision before committing.

There is no existing general runtime settings form, so the Core form contains a separate **Anti-AFK** disclosure, outside **Market / Analyst · параметри**. The latter contains the two Analyst delay fields. Both use backend descriptors and persisted values.

| UI / persisted field | Runtime field | Default |
| --- | --- | --- |
| antiAfkEnabled | enabled | true |
| antiAfkMinIntervalMs | minIntervalMs | 35000 |
| antiAfkMaxIntervalMs | maxIntervalMs | 50000 |
| antiAfkForwardBlocks | forwardBlocks | 2 |
| antiAfkBackwardBlocks | backwardBlocks | 2 |
| antiAfkMovementTimeoutMs | movementTimeoutMs | 10000 |
| antiAfkRetryDelayMs | retryDelayMs | 5000 |
| analysisRealmReadyDelayMs | task.timing.realmReadyDelayMs | 15000 |
| analysisRealmReadyDelayJitterMs | task.timing.realmReadyDelayJitterMs | 3000 |

BotConfigurationService reads runtime configuration at worker startup and sends it through the existing init payload. A committed Anti-AFK policy edit sends `runtime:configure` through existing BotProcess event IPC to running workers, even with autonomous Core disabled. Applying configuration cancels current movement, releases controls, and reschedules with the new settings. Offline bots receive persisted settings at their next start. Core enable/disable does not enable/disable this runtime service.

Analyst delay settings travel with AnalysisTask. Existing revision cancellation rejects older tasks after policy changes. The session-duration validation includes the worst-case realm delay in addition to auction timing; increasing this delay can require increasing the analysis session timeout.

## Realm readiness

`Bot.setPositionStatus('realm')` is the readiness boundary. The existing sidebar detector confirms realm statistics after the requested `/an<target>` transition. It now requires the requested realm to match the configured target. TCP connect, spawn, authentication, configuration and hub state do not begin the delay.

`RealmReadyGate.enter()` records the confirmed entry timestamp and samples jitter once for that entry. `AnalystTask.assign()` awaits the remaining time **before** constructing the auction execution:

`readyAt = enteredAt + baseDelay + floor(random * (jitterMs + 1))`.

Defaults yield 15–18 seconds after confirmation. A task arriving later only waits the remaining interval; successive tasks on the same realm do not restart the delay. Disconnect, kick, stop/restart, configuration transition, death, authentication, hub or realm change invalidate the gate and abort pending waits. An entry generation and target check prevent old waits from executing. Existing task AbortSignal and worker/session/revision checks remain in force. Manual `/hub`, `/lobby`, `/anN` commands invalidate readiness before sending.

## Prevention: normal realm inactivity

Each Bot owns one AntiAfkManager. It performs physical movement **only as prevention** in a confirmed target realm: inactivity timer -> configured forward distance -> configured backward distance -> continue work. All seven antiAfk settings above remain valid. The default timeout is still 10 seconds, retry delay 5 seconds, and randomized inactivity interval 35-50 seconds.

Movement snapshots numeric coordinates, uses horizontal displacement only, and releases controls on completion, timeout, role interruption, blockers, realm loss or stop. The return phase stops within 0.2 blocks of origin or at the configured backward displacement. Tokens, inventory locks/busy state and open windows retain their existing safety semantics. Analyst can yield between observations; Reseller uses the same shared safe points. Passive packets/chat/inventory activity do not reset the inactivity baseline.

A prevention MOVEMENT_TIMEOUT only schedules another preventive attempt after the configured delay. It never requests /hub. There is no physical recovery mode, requestRecovery method, recoveryPending flag or retained AFK movement target.

## Recovery: confirmed AFK -> hub -> configured realm

The existing known FunTime response emits bot:afkDetected. Bot delegates to the shared runtime AfkRecovery controller; no role implements recovery.

1. Coalesce duplicates into the current generation. Set positionStatus=afk, invalidate RealmReadyGate, cancel preventive movement/timer and interrupt the current role.
2. Await BotTaskRunner completion, including asynchronous role cleanup. Then await independent movement/inventory/window blockers. No unrelated GUI is forcibly closed.
3. Send one /hub through the existing sendChat command mechanism. Its realmConnecting state means a transition was requested, **not** that hub arrival was confirmed. requestedRealm is cleared.
4. Wait for existing actual lobby evidence: a lobby status update or the established FunTime welcome/realm-entry fallback message handled by MessageEvents. BotActions.connectToRealmTask routes this evidence through the active transition owner.
5. Reuse the existing connectToRealm action. It takes accountData.realm (not a hardcoded realm), retains the existing short randomized tick wait and sends /an<configuredRealm> through sendChat. Session identity, generation, target, status and AbortSignal are checked again after that wait. Repeated lobby evidence does not send another command.
6. Wait for the existing sidebar detector with a matching requested target. Sending /an alone does not confirm realm. Cached sidebar state is cleared on loss of realm and only fresh relevant lines can confirm it. The previous post-movement /ah readiness probe has been removed.
7. RealmReadyGate.enter records the real confirmation timestamp. Recovery awaits the gate before the worker starts a replacement role. Reseller uses its existing realmStartDelayMs with zero additional jitter; other roles use gate defaults (15-18 seconds). Analyst still separately enforces the timing attached to each newly assigned analysis task.
8. Emit readiness/completion, release transition ownership, and establish a fresh randomized prevention baseline using configured values. The internal bot:workReady notification starts the role through the existing worker lifecycle.

Tasks are **cancelled and reassigned/restarted**, not partially paused. Analyst cancellation reports AFK_INTERRUPTED, releases its old Core session/reservation, and publishes unavailable when cleanup ends. After readiness a new Analyst instance advertises availability and Core assigns a new analysis ID. Reseller starts a new role instance. Core pricing/planning/market behavior is unchanged.

## Cancellation and bounded failure

Only a running, living bot in a confirmed target realm can start recovery. Prevention may be disabled without disabling AFK hub recovery. One active generation owns the transition. Repeated AFK messages do not reset deadlines or issue commands.

Stop/restart, disconnect, kick, worker exit/shutdown, death, authentication/captcha restart, explicit manual transitions and start_configuration cancel the old recovery. Configuration cancellation deliberately hands control back to the existing connection/login lifecycle; it does not preserve or revive old recovery callbacks. Any subsequent connection lifecycle uses fresh server evidence. The recovery signal and captured client/realm/generation stop delayed /an callbacks from writing to a replacement session. Stop and configuration also invalidate pending normal realm-entry generations.

Role cleanup/independent blockers, hub arrival and realm arrival each have a bounded 30-second deadline. Gate readiness has its selected delay/jitter plus a 5-second margin. Command rejection or deadline expiry emits a structured failure once, stops prevention and emits bot:fatal with reason afk_recovery_failed. The existing worker exit and BotManager reconnect/backoff policy owns retries. The controller does not loop /hub or /an, and its failed latch rejects additional requests in that session. Successful recovery uses a new baseline, never the overdue pre-AFK timer.

Physical movement is not proof that FunTime cleared AFK. Current recovery relies on real lobby/realm evidence and the existing gate, not a fabricated status after sending a command. The sidebar remains a statistics detector plus requested-target correlation; it cannot independently prove the realm ID of a silent server redirect. Live FunTime validation is still required for lobby messages, configuration handoff and command availability after the gate.

## Telemetry and diagnostics

Physical bot.antiAfk.* events now always carry mode=prevention: scheduled, started, forwardCompleted, returnCompleted, completed, deferred, cancelled, failed, diagnostic. bot.antiAfk.recoveryRequested has been removed.

Shared recovery events are persisted through the existing worker bridge as bot.afkRecovery.started, hubRequested, hubConfirmed, realmRequested, realmConfirmed, ready, completed, failed and cancelled. They contain bot/account IDs, generation, configured target, phase, timestamp and safe reason codes. They carry no passwords, chat payloads or per-tick logging.

Movement/control/packet diagnostics now trace prevention only. They do not observe a physical recovery path because that path no longer exists. Packet traces remain bounded to one prevention attempt per client registration and do not send fake movement packets.

## Verification and changed files

Deterministic tests cover preventive forward/back motion and timeout/retry; AFK cancellation without recovery movement; one /hub across duplicates; cleanup and independent blockers; actual lobby evidence; configured target selection through the existing action; no fake realm confirmation; gate-delayed role restart; fresh prevention baseline; stale callbacks after stop/restart/session replacement/death/authentication/configuration/kick/shutdown; command rejection and transition/gate timeouts; and no hub on movement timeout. Integration tests cover real worker/Core Analyst reservation release/reassignment (including a lost failure event) and Reseller replacement after gate readiness.

Superseded physical-recovery and auction-probe tests were replaced with hub-recovery tests. Existing prevention, protocol serialization, storage, Telegram, market and Core tests remain in the full suite. No live server connection is made by these tests.

Final full suite: `npm test` — **158 passed, 0 failed**.

Changed runtime files:

- src/minecraftBot/runtime/afkRecovery.js (new shared transition controller)
- src/minecraftBot/runtime/antiAfkManager.js
- src/minecraftBot/runtime/movementPacketTrace.js
- src/minecraftBot/bot.js
- src/minecraftBot/botActions/botActions.js
- src/minecraftBot/botActions/actions/connectToRealm.js
- src/minecraftBot/handlers/botEvents/configurationEvents.js
- src/minecraftBot/handlers/botEvents/sidebarEvents.js
- src/minecraftBot/taskRunner/botTaskRunner.js
- src/minecraftBot/worker/roleLifecycle.js
- src/minecraftBot/worker/sendChat.js
- src/minecraftBot/worker/botWorker.js
- src/events/events.js
- src/events/workerEventNormalizer.js
- src/events/eventPersistence.js

Tests: tests/runtimeReliability.test.js and tests/movementPacketTrace.test.js. Documentation: this file plus the two movement investigation reports, updated to describe prevention-only diagnostics.
