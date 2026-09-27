# Core v2 Phase 5 — lifecycle arbitration and graceful stopping

## Pre-change audit — recorded before implementation, 2026-09-26

The Phase 1–4 reports and their historical audit, settings inventory, proposal and migration plan distinguish policy, observation, action ownership and scheduling. Source inspection confirmed that Phase 4 did not arbitrate supervisor mechanics. This section records the pre-change baseline; the implementation and verification below supersede its lifecycle limitations.

| Mechanism / source | Decides → executes | Durable ownership before Phase 5 | Completion evidence | Restart behavior / concurrent Core risk |
|---|---|---|---|---|
| Core assignment START, CoreReconciler/CommandService | Core plan → assignment/configuration → BotManager.startBot → BotProcess.start/fork | ActionLedger bot/account claims; task and pending mirrors | Fresh expected account/task/role readiness, accepted incarnation when available | Ledger repairs actions; independent supervisor can restart the same bot |
| Core idle Analyst STOP | Core plan → CommandService → BotManager.stopBot → BotProcess.stop | STOP bot/account claim | Phase 3 PROCESS_MISSING observation | Supervisor desiredState is only in memory; no workload acknowledgement |
| REPLACE | Core plan → AccountReplacements → existing generation/assignment/start commands | REPLACE bot/account claims, replacement rows, generation receipt | Expected replacement account and readiness | Generation is idempotent; supervisor/configuration/binding restart can still bypass ownership |
| Manual start/stop/restart | Operator CommandService → BotManager | Core manualHold and cancellation; manager intent/timers not durable | Start acceptance / later observation; stop transport/exit | Holds survive but lifecycle intent and mechanical continuation do not; concurrent awaited manual/Core callbacks rely on partial guards |
| Archive/remove/discard | DB/operator/definition synchronization → BotManager | Archived definition/account constraints; no shared lifecycle claim | Worker exit / missing handle | Remove/archive can stop directly; discard rejects a live handle |
| Worker crash, kicked/disconnected/fatal exit | Worker runtime exits → BotProcess exit → BotManager crash handling | In-memory desiredState, crashHistory, reconnectAttempts | New worker initialized/status events; old stable timer resets on cached running | Restart erases backoff; supervisor can start despite a Core action or policy change |
| Reconnect | BotManager hard-coded crash budget/backoff → timer → private start | No action/resource claim; timer only | Worker process/role observations | Timer disappears on parent restart; independent start authorization |
| Requested restart | BotManager.restartBot → stop → exit callback → private start | restartRequested boolean | New worker and readiness, no action correlation | Flag lost on restart; callback can conflict with a newer Core/manual intent |
| Configuration restart | BotConfigurationService two-second sync, optional 750 ms restart timer → BotManager.restartBot | Config DB/fingerprint; timer and lastAttempt in memory | Applied configuration fingerprint | Separate autoRestartOnSettingsChange authority, bypasses Core resource ownership |
| Binding restart | TelegramManager successful correlated binding → BotManager.restartBot | Telegram/account/session data; binding operation transient | Bound nickname success, then ordinary worker restart | Telegram authorization is separate; lifecycle request bypasses Core ownership |
| Heartbeat failure / IPC disconnect | BotManager heartbeat interval → BotProcess.kill; IPC clears fact authority | No durable recovery decision; process evidence separate from facts | OS/child exit then reconnect | Temporary unresponsiveness can trigger kill without quiescence |
| Role initialization / realm re-entry | roleLifecycle → BotTaskRunner.start/stop | Loaded task configuration; local generation guards | Realm gate and role facts | Worker-local mechanism, no global spawn; must be fenced during quiescence |
| Anti-AFK / AFK recovery | AntiAfkManager/AfkRecovery → local movement, realm commands, role interruption; fatal event on failure | Runtime configuration; local cancellation/generation | Realm/progress events and facts | No global capacity decision; fatal exit delegates to independent supervisor |
| Reseller work | ResellerTask cycle → buyer/inventory/seller/relist server action queue | Task/prices only; local cycle/GUI/incident state | Actual inventory/server result parsers | Existing stop flips running false and closes window, with no proof transaction boundary is safe |
| Analyst work | AnalysisCoordinator → AnalystTask/AnalystExecution | Analysis sessions; worker job/abort controller | Session observation/result; job cleanup | Read-only auction job can be cancelled, but STOP currently does not await cleanup |
| Process termination | BotProcess.stop → worker stop command → bot/task stop; five-second kill fallback | No stop acknowledgement | Authoritative process absence | “Graceful” name currently does not imply safe economic boundary |
| Startup | main composition → configuration sync → Core observation/recovery | Policy/actions/receipts retained; manager intent absent | Observation/ledger | Cannot reconstruct supervisor retry safety from transient timers |
| Shutdown | main signals → Core.stop → Telegram/Web shutdown → process.exit | Actions survive, worker state transient | Worker parent disconnect exits | Core timers close; manager heartbeat/configuration/retry mechanics lack one explicit shutdown gate |

### Concrete defects requiring changes to completed contracts

1. Durable action exclusivity currently stops at the command boundary: supervisor/configuration/binding starts do not consult `bot:<id>`. Phase 5 will extend enforcement to mechanical launch/termination, preserving the Phase 3 ledger as owner.
2. A START without accepted incarnation can currently complete from unrelated matching readiness. Newly arbitrated launches must durably correlate their authorized incarnation before spawn; imported pre-Phase-5 evidence keeps its documented compatibility treatment.
3. The five-second fallback can interrupt an unsafe Reseller operation. Normal autonomous graceful STOP must never use that force path without a correlated safe acknowledgement. Process absence, not acknowledgement, remains completion.
4. Supervisor backoff and desired intent are erased by parent restart. Prunable action history cannot reliably retain them indefinitely. A small durable per-bot lifecycle record is justified; it will not hold scheduler state or claim process liveness.
5. Shutdown lacks a single gate across manager/configuration/binding continuations. Shutdown must close policy admission and mechanical retries before waiting for workers.

### Intended authority boundary

Canonical policy and the existing Phase 4 evaluator authorize autonomous recovery/stop opportunities. Existing action resources own lifecycle transitions. A lifecycle arbitration boundary validates ownership and incarnation immediately before BotManager mechanics. BotManager retains fork/IPC/exit detection and authorized mechanical continuation. Configuration and binding submit reasons, not independent restarts. Manual commands supersede autonomous ownership explicitly. Worker-local recovery remains local but cannot admit a new role once quiescing.

No production database or Minecraft connection was used as a Phase 5 test fixture.

## Implemented ownership model

Canonical Operations Policy permits autonomous transitions. The existing serialized Phase 4 OBSERVE → ACCOUNT → PLAN → SELECT → RESERVE → DISPATCH pipeline gives them bounded opportunities. `ActionLedger` remains the only resource authority. `LifecycleArbiter` validates policy, manual ownership, durable recovery state and action ownership; BotManager executes fork, IPC and termination mechanics. There is no additional Core evaluator or supervisor policy polling loop.

| Responsibility | Authority after Phase 5 |
|---|---|
| Desired role capacity | Existing canonical policy, schedule and DesiredState |
| Per-bot running/stopped intent and manual/core ownership | Durable `coreLifecycle`; intent is never proof of a live process |
| Exclusive operational transition | Existing START / STOP / REPLACE action and `bot:<id>` / account claims |
| Recovery opportunity | Lifecycle plan in the existing scheduler, with canonical permission/backoff/spacing checks again at reservation |
| Mechanical process operation | BotManager/BotProcess, with an active action and ownership epoch checked before spawn/termination |
| Transport failure / worker exit / heartbeat timeout | BotManager detects; it submits a durable request instead of starting or killing independently |
| Configuration restart | Configuration service detects stale configuration; its optional existing switch generates a request. Lifecycle arbitration alone permits execution |
| Binding restart | Telegram keeps authorization and correlation. An active START/REPLACE continues under its existing claim through a scheduled `continue_binding` opportunity |
| Realm entry, role initialization, Anti-AFK | Worker-local runtime; TaskRunner's quiescence latch prevents new roles after stopping begins |
| Operator commands | Existing persistent manual hold cancels prior claims and fences callbacks; a new manual START/STOP action owns the command |
| Application shutdown | Admission closes globally, then bounded worker quiescence and explicit infrastructure termination |

`installLifecycle` disables old reconnect/stability timers on manager installation. Production composition always installs arbitration through AutonomousCore before lifecycle commands. The standalone BotManager compatibility branches remain for existing isolated runtime fixtures; they are not a second authority in the composed application. Calling the composed manager's `startBot` or ordinary `stopBot` without ownership fails rather than silently falling back.

Reservations now invoke an optional ledger hook inside the existing resource transaction. Lifecycle intent, epoch and initial action metadata commit with the claim, before `core.action.created`. A failed admission rolls back both intent and resources. Incarnation/launch metadata and `lastStartAt` also commit together before fork. This extends Phase 3 at the mechanical boundary without replacing resource keys, generation receipts, action types or scheduler ownership.

## Evidence and action settlement

Lifecycle action metadata contains `lifecycle`, ownership `epoch`, operation, originating/accepted incarnation, phase, spawn evidence, binding continuation flag and correlated stop evidence. Phases distinguish reserved, quiescing, safe-to-stop, stopped-between-restart, and starting/awaiting readiness. They are not a replacement for action states or worker facts.

- A new START/REPLACE can complete only after its own authorized spawn and fresh matching incarnation/account/task/role work readiness. A matching unrelated ready process cannot complete it.
- STOP completes only on authoritative process absence, either the child's exit (after BotProcess clears its handle) or Phase 2 `PROCESS_MISSING`. Safe ACK, command acceptance, stale facts and unavailable observation do not complete STOP.
- Unexpected exit during START/REPLACE awaiting readiness fails the action, releases its resources and commits failure/backoff. It does not launch a process inside the exit callback.
- Exit during an owned restart's quiescence advances the same START/REPLACE to its stopped phase; only its still-valid continuation may launch the replacement incarnation.
- Exit during STOP completes STOP even if a safe ACK never arrived: physical absence is proven. This is not a claim that a crashed economic transaction succeeded.
- Old-child callbacks, old incarnation ACKs and mismatched action IDs cannot settle a current quiescence request or terminate a newer process. Malformed evidence fails the individual request.
- Imported pre-Phase-5 actions retain Phase 3 observation-only compatibility. They are not retroactively represented as correlated new launches or blindly replayed.

## Graceful STOP and Reseller boundaries

Normal autonomous and manual STOP use the same protocol:

1. Reserve ownership and persist stopped intent.
2. Send `lifecycle:quiesce` with action ID and incarnation.
3. Worker publishes quiescing, fences TaskRunner starts, cancels AFK recovery/movement, and waits for role cleanup.
4. Analyst cancels its read-only job and waits for cleanup. Reseller requests a checkpoint without cancelling an in-flight economic operation.
5. Worker replies safe only after draining and finding no sticky uncertain result. Otherwise it reports unsafe with a bounded reason code.
6. Parent validates child/action/incarnation/epoch and current authority, records evidence, and sends the existing worker stop command with the five-second kill fallback disabled.
7. The ledger waits for actual process absence.

The Reseller implementation uses its actual cycle, buyer confirmation/verifier, seller response, relist response and serialized inventory/server operations. A buyer scanning for a lot can leave at a checkpoint before another transaction; an in-flight purchase continues through inventory verification. Inventory cleanup finishes before the next transaction is suppressed. Listing/relisting awaits its existing server result. New cycles do not start after quiescence. A failed server action, unconfirmed purchase, sell timeout/cancellation after send, unconfirmed relist or failed owned-window cleanup marks the incarnation uncertain. No elapsed timer certifies safety. Sticky uncertainty requires operator intervention; it is not cleared by a later successful unrelated operation.

The general contract remains **partially supported**, because current code cannot resolve every uncertain economic outcome. It refuses a normal stop rather than asserting a safe result. No trading planner, autonomous buying/selling/repricing or Trading Intelligence was added. Existing transaction code only gained safety evidence/checkpoints. `TRADING_EXECUTION_DISABLED` still blocks ordinary autonomous Reseller assignment and recovery launches. Existing account replacement behavior remains available under its original permission.

### Timeout and force semantics

`transitions.gracefulStopTimeoutMs` bounds the ACK wait. The action deadline also bounds termination/readiness. Timeout, lost IPC or unsafe evidence leaves the worker alive and the failure visible; no automatic graceful-to-kill escalation exists. A late ACK from a failed/cancelled action cannot trigger termination. A quiesced process is not automatically resumed by dropping an action claim.

The deliberately explicit operator API is `bot.stop` with `{botId, force:true}`. It creates a manual STOP whose metadata authorizes force; mechanics reject force for an autonomous or non-force action. It bypasses quiescence but still needs process absence for completion. Normal UI Stop remains graceful; there is no new one-click force button. A live bot must be stopped before archival/removal, avoiding an archive-time kill bypass. Permanent-ban and ban-persistence-failure safety intervention retain their existing explicit stop/escalation exception after cancelling lifecycle ownership; these are not ordinary capacity reduction.

Application shutdown is a separate infrastructure exception: close Core/manager/configuration admission, cancel mechanical waits, quiesce workers concurrently within five seconds, send normal stop after safe ACK, and force remaining workers at the bound (or after unsafe/unavailable response). Durable uncertain actions are retained, not marked successful merely to exit. Parent-IPC loss and fatal worker crashes remain infrastructure exits, not policy stop success.

## Recovery, spacing and policy truth

Failures and retry deadlines are durable per bot. Delay is `min(restartDelayMaxMs, restartDelayMinMs * 2^(failures-1))`, with the exponent bounded. A crash/failure does not recreate an independent reconnect timer. Reconsideration uses existing events/coalescing and periodic safety evaluation; a retry deadline is a minimum, not a promise of immediate execution at that millisecond.

The failure count includes the failed initial attempt; at most `maximumRestartAttempts` further retries are allowed before exhaustion. A restoration request with no prior failure may make its initial attempt. Failures are reset only after 60 seconds of confirmed work readiness in the current launch. `stableSince` is cleared by a new spawn, exit or lack of ready evidence. Reopening the database and pruning action history do not reset backoff. Manual commands bypass autonomous admission limits, but cannot bypass resource/incarnation checks; their successful readiness must meet the same stability rule before counters reset.

Start/stop spacing uses durable last-spawn/observed-exit timestamps plus active reservation creation times. Minimum runtime/downtime applies to normal capacity transitions; confirmed recovery bypasses those minimum-lifetime guards while retaining concurrency, global intervals and backoff. A live recovery also checks stop concurrency/spacing. Manual commands explicitly bypass those autonomous timing limits. The old generic Core failure retry is no longer applied to lifecycle actions, preventing two competing retry authorities; it remains for non-lifecycle operations.

| Policy field(s) | Status and actual consumer |
|---|---|
| `transitions.maximumConcurrentStarts`, `maximumConcurrentStops`, `startIntervalMs`, `stopIntervalMs` | Supported by LifecycleArbiter admission; manual commands are explicit overrides |
| `transitions.gracefulStopTimeoutMs` | Supported ACK deadline in lifecycle mechanics; does not authorize force |
| `stability.minimumBotRuntimeMs`, `minimumBotDowntimeMs` | Supported with durable lifecycle timestamps; recovery/manual exceptions above |
| `stability.scaleUpCooldownMs`, `scaleDownCooldownMs` | Unsupported; no fabricated consumer |
| `recovery.restartOnCrash`, `restartOnDisconnect`, `restartOnUnexpectedStop` | Partially supported: canonical autonomous Analyst recovery; Reseller trading launch remains blocked |
| `recovery.maximumRestartAttempts`, `restartDelayMinMs`, `restartDelayMaxMs` | Partially supported with durable failure sequence/backoff, not a sliding health window |
| `recovery.restartWindowMs`, `replaceUnhealthyAccounts` | Unsupported; no automatic unhealthy-account rotation/window reset |
| `recovery.autoReplaceBannedAccounts` | Existing supported replacement permission retained |
| All `health.*` thresholds/quarantine fields | Unsupported; permanent bans, explicit incidents and observation uncertainty remain distinct |
| Role `stopMode` | Unsupported selector; normal stop always requires a safe checkpoint, even if stored mode is immediate |
| Role `autoStart`, `autoReplace`, minimum/reserve-minimum fields | Existing unsupported status retained; no implicit new executor |
| Maintenance | Partial: prevents autonomous starts/recovery; with automation/allocation enabled requests safe scale-down to zero, subject to manual holds and safety |

Capabilities, setting metadata, policy help and Ukrainian maintenance preview were updated with these actual consumers. Process alive, IPC/MC transport, heartbeat responsiveness, realm readiness, role readiness, work readiness, recovery/backoff, manual block and uncertain observation remain separate facts. A heartbeat timeout requests reconsideration; it cannot independently duplicate or force a worker.

## Manual, replacement, configuration and binding interaction

Manual START/STOP/RESTART first use the existing durable hold and ledger cancellation. An epoch change invalidates old mechanics and pending quiescence. Restart uses one START claim through stop → absence → new incarnation → readiness. START on a live process is rejected instead of reserving an action that can never observe a new launch. Releasing manual control permits subsequent autonomous work but lets an already accepted manual action finish under its original resource claim. Manual holds prevent autonomous crash recovery until released, including while Core is disabled.

REPLACE keeps its existing selection/generation executor, transaction receipts and account claims. Lifecycle admission validates `mayReplace` rather than incorrectly requiring ordinary allocation permission. Supervisor/configuration requests cannot steal its bot. The replacement's correlated binding restart is a continuation of that same action, not another generation or account selection.

Configuration restart requests persist and wait for current ownership to settle; the eventual authorized launch prepares current configuration. The existing configuration switch only determines whether a change submits a request, not whether it may execute. Manual ownership can leave a configuration change awaiting operator action.

A binding request during START/REPLACE sets durable pending evidence so old readiness cannot prematurely complete it. `continue_binding` goes through Phase 4 selection/action limits, keeps the existing claim and generation receipt, drains the old incarnation, then starts exactly once. Duplicate heartbeat requests cannot overwrite this pending binding continuation. Telegram authentication itself is unchanged. A binding request outside a live owned initialization follows ordinary recovery/manual-hold rules; a timed-out manual initialization may require an explicit operator restart.

## Startup and shutdown repair

| Reopened evidence | Result |
|---|---|
| Reserved, undispatched action | Existing startup cancellation; no blind command replay |
| Dispatched START/REPLACE, correlated ready worker | Existing readiness settlement, requiring new lifecycle correlation where applicable |
| Dispatched lifecycle START/REPLACE, process absent / interrupted restart | Fail interrupted action, release claims, preserve intent/backoff, schedule an eligible recovery opportunity |
| Active STOP, process absent | Complete by authoritative absence |
| Active STOP, process alive / unavailable facts | Retain ownership until evidence/deadline; do not infer safety or replay a force command |
| Durable running intent, absent worker, no action/request | Reconstruct unexpected-stop request during startup ACCOUNT |
| Pending reconnect/configuration/binding request | Retain reason and retry deadline; current policy/manual ownership and resources still gate it |
| Safe ACK recorded before parent crash | Evidence remains in action metadata; ACK alone is not absence or a mandate to replay termination |
| Shutdown during recovery/quiescence | Close admission, invalidate mechanics, retain uncertain action; next startup uses the same rules |

BotManager timers and scheduler cursors are not needed to reconstruct ownership. Replaced process incarnations cannot use old evidence. Unrelated healthy bots remain eligible when another action fails or refuses stopping.

## Scheduler, events and diagnostics

Recovery, capacity STOP and binding continuation enter the same planner and scheduler. Candidate windows, fair bot age, `maxActionsPerCycle`, `maxCandidatesPerCycle`, cooperative budget and finite continuation remain in effect. There is no evaluator in an exit/configuration/binding callback. Binding continuations count as dispatched opportunities even though their reservation is reused.

Lifecycle request events are emitted after durable updates and deduplicated for the same pending reason/incarnation. Quiescence events emit on state changes, not every duplicate ACK. Existing ledger events publish after committed ownership/terminal state. Recovery correctness never depends on delivery of these events.

Backend snapshot `lifecycle` exposes desired owner/intent, active durable action, supervisor state, incarnation, failures, retry deadline, pending reason, blocked reason, safe/unsafe stop evidence and expected next transition. Stop evidence can come from persisted action history after process loss; evidence for an older incarnation is excluded when a newer incarnation exists. Ukrainian UI renders these backend facts alongside Phase 2 observation and Phase 3/4 action/cycle panels; it does not calculate lifecycle truth. Normal Stop is still graceful. Operators can release the existing manual hold explicitly.

## Schema v11 rationale and migration

Schema v10 action history is prunable and contains individual attempts, not a durable running intent or surviving failure budget. A single per-bot `coreLifecycle` row is therefore necessary. It stores no scheduler state or cached liveness.

| Fields | Durability purpose |
|---|---|
| `botId` | Foreign-key identity, cascade on definition deletion |
| `intent`, `owner` | Reconstruct desired running/stopped and manual/Core ownership |
| `epoch` | Fence callbacks from superseded operator ownership |
| `failures`, `retryAt`, `lastFailureAt` | Preserve retry budget/backoff after restart and journal pruning |
| `lastStartAt`, `lastStopAt` | Crash-safe spacing/minimum lifetime evidence |
| `stableSince` | Meaningful work-ready stability before counter reset |
| `requestReason`, `requestIncarnation`, `requestAt` | Recover pending supervisor/configuration/binding request with origin correlation |
| `blockedReason`, `updatedAt` | Persist failure/exhaustion context and update time |

Existing migration machinery makes a complete SQLite backup before upgrade, runs the new table and version record transactionally, checks foreign keys and integrity, and reopens idempotently. Fresh databases now correctly record migration versions 10 and 11 as well. The new table is read-only in the database editor.

The v10 fixture preserves active actions and resource claims, verifies the backup's old version/content, runs `integrity_check` and `foreign_key_check`, and verifies reopening creates no second backup. Existing v1/v2/v3/v4/v8/v9 migration tests still preserve their data assertions; only current-version/backup-name expectations and the intentionally downgraded fixture were updated. No live database migration was run. `npm run migration:check` was deliberately not used because it copies the configured live database; this phase used independently created temporary fixtures only.

## Files changed and purpose

| Files | Purpose |
|---|---|
| `src/core/lifecycleArbiter.js`, `lifecycleState.js` | Shared authority, durable requests/backoff, pure lifecycle planning, operator actions, snapshots |
| `src/core/actionLedger.js`, `actionCoordinator.js` | Atomic admission hook, metadata annotation, correlated readiness, scheduled continuation, lifecycle-specific retry/error handling |
| `src/core/autonomousCore.js`, `coreReconciler.js`, `cycleScheduler.js` | Integrate lifecycle with the existing evaluator and action limits |
| `src/core/coreObserver.js`, `coreActualState.js` | Immutable durable lifecycle facts alongside existing observation |
| `src/core/commandService.js`, `coreMain.js` | Manual arbitration, assigned account claim, bounded application shutdown |
| `src/core/coreCapabilities.js`, `operationsPolicy.js` | Honest supported/partial/unsupported settings and maintenance permission |
| `src/botManager/botManagerMain.js`, `botProcess.js`, `botConfigurationService.js` | Owned mechanics, incarnation-correlated IPC, cancelable waits, supervisor/configuration request conversion |
| `src/telegram/telegramManager.js` | Correlated binding request through arbitration |
| `src/minecraftBot/worker/gracefulStop.js`, `botWorker.js` | Worker quiescence protocol |
| `src/minecraftBot/taskRunner/botTaskRunner.js` | Fence role/realm re-entry and await cleanup |
| Reseller `resellerTask.js`, `resellerBuyer.js`, `resellerSeller.js`, `auction/auctionRelist.js`, `server/resellerServerActions.js` | Real transaction checkpoints and conservative uncertain-result evidence |
| `src/data/databaseSchema.js`, `databaseMigration.js` | Justified v11 table and transactional migration |
| `src/webTerminal/public/js/coreController.js` | Ukrainian backend-driven lifecycle diagnostics |
| `tests/coreLifecycle.test.js`, `browserSmoke.mjs` | New protocol/arbitration/recovery/stress/migration and rendered UI checks |
| Existing schema/capability assertions in Core, storage, market, incidents and Telegram tests | Reflect v11 and implemented capability changes while retaining behavioral/data assertions |
| This report and linked Phase 1–4 addenda | Ownership, exceptions, verification and next-phase boundary |

## Final source ownership audit

The full case-insensitive lifecycle search was repeated over all JavaScript under `src`, including every term requested in the task. The raw result is [artifacts/core-v2-phase5-lifecycle-audit.txt](../artifacts/core-v2-phase5-lifecycle-audit.txt). All process-affecting paths fall into these classes:

| Remaining path | Classification / guard |
|---|---|
| BotManager private start → BotProcess fork | Mechanical; active action/resource/epoch and current configuration/ban checks before spawn |
| Supervisor exit/reconnect/stability branches | Installed arbiter returns before legacy restart/crash-loop/timer decisions; signals feed Core |
| Heartbeat checker | Detector only when composed; requests recovery, no independent kill |
| Configuration restart timer | Deduplicated request generator, cancelled at shutdown; never a policy bypass |
| Telegram successful binding | Correlated request; scheduled existing-action continuation or gated pending recovery |
| Core START/STOP/REPLACE/manual | Shared bot/account resource authority; absence/readiness settlement |
| BotProcess default stop fallback | Retained only for standalone compatibility and explicit ban safety; owned normal STOP passes `escalate:false` |
| BotProcess kill | Explicit authorized manual force or bounded application shutdown; standalone legacy heartbeat path unreachable under installed arbitration |
| Archive/remove/discard/account rotation | Live-process guards; cannot bypass normal STOP or reuse a live account |
| Worker stop command, fatal error, parent disconnect, process exit | Mechanical/infrastructure behavior; never an independent desired-capacity decision |
| Realm re-entry/role lifecycle/Anti-AFK | Worker-local recovery; quiescence prevents new role work |
| Analyst session abort and Reseller operation retries | Existing local workload mechanics; no process fork/owned lifecycle transition |
| Generation retries/receipts, replacement retries | Existing Phase 3 account execution under shared claims; lifecycle launch still checks arbitration |
| Main shutdown | Core/manager/configuration gates close before worker termination and transport teardown |

No unexplained independent policy-level lifecycle authority remains in production composition. Legacy standalone mechanics are explicitly retained, rather than mistaken for a second production supervisor.

## Stress measurements and verification

Measurements are deterministic fake-worker scenarios with real Core, ledger, manager and BotProcess mechanics over temporary databases. They are local timings from the final focused run, not live-server latency guarantees.

| Scenario | Result | Measured work duration | Maximum cycle |
|---|---|---:|---:|
| 24 simultaneous durable crash requests, permanent failure, 100-trigger burst, 48 evaluations | 72 total launches (initial + 2 retries each), all budgets exhausted; no claims leaked; at most 2 dispatches / 8 candidates per cycle | 2099.9670 ms | 94.6936 ms |
| One permanently failing worker among 11 healthy workers | 14 total launches, 11 ready, failed bot bounded to 3 launches, no healthy worker duplicated/starved | 307.3552 ms | 38.1873 ms |
| 12 simultaneous graceful stops, one unsafe worker | 11 completed, 1 visible failure left alive, zero forced kills, at most 3 dispatches per cycle | 383.1702 ms | 68.4016 ms |

In the 24-worker run, the event-loop probe executed 155 times; largest measured interval was 45.2354 ms. This is a cooperative responsiveness measurement, not a hard real-time guarantee. Existing Phase 4 tests separately verify mixed demand, coalescing, deterministic fairness, hung work, large inventories, finite continuation and one evaluator. Existing Phase 3/2 tests retain generation/replacement idempotency, resource exclusivity, observation and work-ready semantics.

| Verification | Passed | Failed | Cancelled | Skipped | Duration |
|---|---:|---:|---:|---:|---:|
| Pre-change full baseline | 315 | 0 | 0 | 0 | 35450.196 ms |
| Final `npm test` | **377** | **0** | **0** | **0** | **43984.6172 ms** |
| Focused `coreLifecycle.test.js` | 62 | 0 | 0 | 0 | 8388.2737 ms |
| Phase 4 `coreScheduling.test.js` | 25 | 0 | 0 | 0 | 5873.261 ms |
| Phase 1–3 / runtime / account / storage regression subset | 223 | 0 | 0 | 0 | 27389.0434 ms |
| `npm run test:ui` | 1 smoke scenario | 0 | 0 | 0 | 6.9851 s shell elapsed |
| `node --check` over source/tests/scripts | 161 files | 0 | Not applicable | 0 | Not measured |
| Repeated source ownership search | 1938 matching source lines classified by mechanism above | No unexplained production owner | Not applicable | Not applicable | Not measured |

The focused and regression commands use the repository's `node --test --test-isolation=none` mode. An initial isolated-file attempt was rejected by the process-spawn sandbox (`EPERM`); it was not counted as a successful test run. The final browser run used the previously authorized isolated headless Chrome smoke setup, its in-memory API and temporary profile. It passed Ukrainian lifecycle evidence/ownership rendering, existing policy/actions/cycle checks, responsive layout and no JavaScript exceptions. No live database or Minecraft server was contacted.

The 223-test subset explicitly ran `coreActions`, `coreObservation`, `corePolicyAuthority`, `coreFoundation`, `operationsAutomation`, `operationsAccountGeneration`, `accountGeneration`, `runtimeReliability`, `runtimeIncidents` and `storageMigration` tests. The final complete run also includes all remaining market, Telegram, database and UI-helper regressions. The last ownership-release correction was checked in both the final complete suite and the final focused suite. The 161-file syntax sweep was followed by a fresh syntax check of the last two changed JavaScript files.

The 62 new tests cover conflict ownership, manual supersession/release, configuration and binding requests/continuations, incarnation/ACK rejection, crashes in START/REPLACE/STOP/restart, unsafe and busy stop boundaries, normal timeout versus explicit force, absence versus unavailable facts, durable spacing/backoff, startup ready/absent/imported states, shutdown during recovery/quiescence, transactional rollback, schema v10 upgrade/backup/reopen, capability truth and three measured stress scenarios. Existing tests retain generation receipt/replacement idempotency and Phase 2 work-ready/Phase 4 fairness contracts.

## Remaining limitations and next-phase boundary

- No autonomous Reseller trading or Trading Intelligence. Safe-stop infrastructure does not enable economic execution.
- Unsafe/unresolved economic results cannot be reconciled by this phase. Normal STOP may fail and leave a quiesced live worker; an operator may use the explicit force API or restart after a safe boundary. Force cannot restore an uncertain transaction outcome.
- Health quarantine, automatic unhealthy-account replacement, sliding restart windows, role-specific start/replace switches, stop-mode selection and scaling cooldowns remain unsupported and are labelled accordingly.
- Canonical recovery is partial for Analyst lifecycle; Reseller recovery launches remain blocked. Existing banned-account replacement is preserved as the prior exception.
- The fixed 60-second readiness stability reset and bounded five-second application shutdown are infrastructure rules, not falsely mapped to unsupported policy fields.
- Manual ownership blocks automatic recovery until release. Configuration requests can remain pending under that hold; late binding after an action deadline may require explicit operator restart.
- Retry and spacing deadlines are minimums. The existing event/continuation/safety loop supplies the next opportunity; there is no second exact-deadline recovery scheduler.
- Database/observation work remains synchronous where it was before; cooperative cycle budgets do not make every SQL operation preemptible.
- Live Minecraft transaction boundaries were not tested; the local protocol proves refusal/defer on uncertainty and correlated absence/readiness, not server-side economic correctness.

Phase 5 supplies one lifecycle authority, durable retry intent, safe-stop infrastructure and diagnostics for a later explicitly requested operational/workload separation phase. The next phase was not started. Deployment would migrate the configured database to v11; this work did not start the application or migrate the production database.
