# Core v2 Phase 4 — controller scheduling

> **Phase 5 update — 2026-09-26:** [Lifecycle arbitration and graceful stopping](core-v2-phase5.md) now uses the shared action ledger, durable recovery state (schema v11), correlated quiescence, and truthful lifecycle settings/diagnostics. Historical lifecycle limitations below describe their original delivery. Autonomous Reseller trading remains disabled.

## Pre-change ownership audit (2026-09-26)

The inspected Phase 1–3 source, not only its reports, establishes these owners:

| Mechanism | Owner / mutation boundary | Phase 4 treatment |
|---|---|---|
| Event debounce, trigger map, drain promise | AutonomousCore; one serial cycle but unbounded drain loop | Bound admission/drain and preserve coalesced signals |
| 10-second check / 60-second authoritative scan | AutonomousCore timer / CoreObserver | Preserve independent periodic verification |
| Schedule boundary timeout | AutonomousCore, effective Operations resolver | Wake the same queue |
| Worker query deadlines/concurrency | CoreObserver → BotManager → BotProcess | Existing bounded read side; unchanged facts/identity contract |
| Pure desired calculation | CoreDecisionEngine | Keep desired separate from scheduler admission |
| Candidate planning | CoreReconciler | Add bounded candidate admission and deterministic selection |
| Replacement settlement inside plan | AccountReplacements writes rows, journal, notifications and cancellation | Move to explicit pre-plan settlement boundary |
| Ledger reservation/terminal settlement | ActionCoordinator / ActionLedger | Preserve transactional ownership and terminal semantics |
| Per-action promise and deadline timer | ActionCoordinator | Keep executor guards; include dispatch waits in cycle budget |
| Generation transaction / receipts | Existing DB manager and command path | No new generator or competing reservation authority |
| Assignment queue / AccountPool set | AccountAssignmentService / AccountPool | Low-level serialization and safeguards remain |
| Analysis sessions and dispatch | AnalysisCoordinator | Explicit workload settlement/dispatch boundary, bounded bot admission |
| Supervisor reconnect/start/restart/stability timers | BotManager | External owner; no Phase 5 transfer |
| Configuration sync / runtime role / Telegram / Anti-AFK | Existing subsystem owners | Not additional Core evaluators; unchanged |

Concrete correctness issues identified before changing implementation:

1. `schedule()` silently discards a new trigger type after 20 map entries; `drain()` clears triggers arriving during a failed pass. Both violate eventual reconsideration.
2. `drain()` can consume an endless stream of follow-up passes without a macrotask boundary or bounded return to callers.
3. Reconciler plans mutate replacement rows and journal records. Repeating planning can change its input reality.
4. Bounded 10 ms per-action dispatch does not bound a pass containing many actions, candidate journals or repeated snapshots.

The planned correction preserves all durable Phase 3 action contracts. Scheduler state controls admission only and remains ephemeral. New controller limits will live in the existing canonical Operations JSON, with defaults for old documents; schema v10 need not change. Cooperative budgets cannot preempt a synchronous SQLite/JavaScript call; diagnostics must report actual duration and overruns rather than promise a hard realtime deadline.

## Implemented architecture

Phase 4 is implemented against the Phase 1–3 code, with schema v10 retained. No production Reseller trading, general Reseller STOP, or supervisor ownership transfer was added.

Before: a debounced trigger map drove an unbounded serial drain; each pass calculated desired state, planned and attempted every action. Replacement planning also performed settlement writes. A bounded executor wait did not limit the aggregate pass.

After: the same `AutonomousCore` owns one authoritative promise and a bounded drain. Every pass has a monotonic cycle ID, captured policy/input revisions, a monotonic elapsed-time budget and the following explicit stages:

| Stage | Responsibility and permitted effects |
|---|---|
| OBSERVE | Refresh authoritative worker evidence through CoreObserver/BotManager, within remaining scan time. Preserve immutable snapshot, incarnation and uncertainty semantics. |
| ACCOUNT | Import legacy work on startup, reconcile durable actions, explicitly settle replacement rows, then re-read reality. Startup import precedes replacement settlement so a ready legacy replacement retains its REPLACE history. |
| PLAN | Calculate complete desired state and persist its version if changed. Pure candidate planners describe work from actual/desired/policy/override inputs and the admitted inventory window. |
| SELECT | Apply deterministic ephemeral age/priority ordering; admit at most the candidate limit and select at most the action limit. No operational reservation here. |
| RESERVE | Recheck current reality and claim resources transactionally through the existing ActionCoordinator/ActionLedger. A scheduler selection is never an ownership claim. |
| DISPATCH | Use the existing guarded executor and its bounded acceptance wait. Executor acceptance does not prove readiness or completion. |
| SETTLE_WAIT | Reconcile durable evidence again, settle/dispatch Analyst workloads within the remaining action allowance, and publish backend diagnostics. |

At asynchronous checkpoints the controller checks shutdown generation and the Core input revision. Superseded passes enqueue fresh evaluation instead of dispatching stale plans. Readiness and reservations are rechecked by the existing execution boundary as well. The startup recovery flag survives a superseded or time-limited first pass until accounting actually runs.

### Limits and admission

These settings are canonical `operationsPolicy.controller` fields. Missing fields in old JSON receive defaults on read/merge; edits use the existing optimistic Operations revision. No additional settings authority or database migration exists.

| Setting | Default | Accepted range | Enforcement |
|---|---:|---:|---|
| maxActionsPerCycle | 8 | 1–100 | Operational selection/reservation/dispatch cap; Analyst workload dispatch uses only the leftover allowance. |
| maxCandidatesPerCycle | 128 | 1–2000 | Candidate admission/diagnostic budget; also bounds each rotating bot and item planning window. |
| cycleBudgetMs | 5000 ms | 50–30000 ms | Remaining observation scan time and checkpoints before later stages/action attempts. |
| yieldBudgetMs | 10 ms | 1–50 ms | `setImmediate` at a checkpoint after the cooperative slice expires. |
| continuationDelayMs | 250 ms | 50–60000 ms | Pace continuation-only work and remaining passes after a drain limit. |
| maxPassesPerDrain | 2 | 1–10 | Bound passes performed before returning the authoritative drain promise. |

Candidate admission is distinct from full observation and desired-state accounting: those must see all durable ownership and existing capacity. Each pass constructs candidate descriptions for at most the admitted bot/item windows plus aggregate blockers/generation. This description count may exceed the candidate admission limit, for example 32 bot candidates plus one aggregate blocker. Only the bounded shortlist is considered for selection/diagnostic processing; `candidatesProduced` and `candidatesConsidered` report these separately. Blocked diagnostics fill spare shortlist capacity after eligible plans. Unselected eligible plans remain demand, not discarded work or successful reservations.

The budget is cooperative, not a hard realtime deadline. Synchronous SQLite operations, snapshot cloning, desired accounting and an individual synchronous planner/executor call cannot be interrupted. Checkpoints prevent further admissions after exhaustion; actual elapsed time and `CYCLE_TIME_BUDGET` expose overruns, including an overrun in the last stage. Observation remains capped by its existing maximum scan deadline as well as remaining cycle time. Existing per-action acceptance waits are at most 10 ms, while action deadlines remain separate durable lifecycle limits.

### Ordering, fairness and continuation

Initial ordering uses operation class (idle Analyst STOP, replacement, assignment/start, release, account generation), descending role priority, then stable role/action/bot/item keys. This is an opportunity order, not permission to bypass executor constraints.

Within groups, the least recently selected candidate goes first. Groups are aged by their oldest eligible member and receive one candidate each per selection round. New candidates enter at the current selection turn rather than receiving permanent precedence over older work. Selection ages an attempt even if reservation fails. Bot ages are also passed as read-only admission inputs to planners: otherwise a one-slot deficit could hide every alternative behind the same failed first bot before selection even runs. Existing readiness, permission and safe-transition filters remain authoritative.

Bot and item windows rotate numerically across the full inventory. The tests include two role groups across four windows with a one-action budget and permanent attempt failure; all 64 candidate identities receive opportunities. Aging by eligible members avoids phase-lock between a global role cursor and inventory window rotation. This is fairness for finite, repeatedly eligible inventory, not a wall-clock guarantee for blocked work or an infinitely growing inventory.

Continuation is requested for deferred eligible candidates, inventory outside the current window, isolated failures, or time exhaustion. External input grants a finite revisit allowance derived from inventory/window and inventory/action counts; successful new reservations allow an additional progress check. Internal action-change and continuation signals do not reset the allowance. Once unresolved work consumes it, the controller waits for meaningful new input or periodic safety reconciliation. Pure continuations always use the configured delay, including when the drain has capacity for another pass. Thus failures/backoff/blocked inventories do not create an unbounded immediate loop.

`unvisited` means objects outside **this pass's window**, not unique remaining objects in a global sweep, eligible action demand, or healthy capacity. The Ukrainian UI labels that distinction explicitly. `deferred` counts eligible plans not selected/attempted in the current pass; full demand remains in desired state and transition accounting.

### Triggers, failure isolation and shutdown

All startup, semantic worker, policy, action, schedule, user and safety signals enter the same queue. Repeated types coalesce. Distinct overflow is represented by a forced-observation aggregate instead of being silently dropped. Total received signals and coalesced type count are separate diagnostics. The queue remains bounded apart from the fixed critical trigger types.

Signals arriving during observation/evaluation remain queued. A failure preserves those signals and schedules them after the drain; a failed batch itself is not immediately replayed forever. The periodic safety scan is the fallback for failure without a newer trigger. No second evaluator was introduced. At most the configured number of passes run per drain, with a macrotask boundary between passes.

Replacement, Analyst and generation planning components have isolated failure diagnostics. Reservation/dispatch failures are handled per selected candidate so later independent candidates still proceed. Existing ActionCoordinator catches asynchronous executor errors and settles their durable state. Analyst workload planning/sending also isolates a bot's synchronous failure, fails its session when present, and reports the failure. A corrupt global observation/accounting or journal/storage failure fails the whole pass rather than pretending a trustworthy plan exists. Logs/diagnostics use safe codes, not raw executor secrets.

Stop marks the controller stopped, invalidates generation, clears debounce/schedule/safety timers and queued triggers, aborts observation, closes action jobs, stops analysis and waits for the authoritative pass. Startup cannot install a safety interval after a concurrent stop. Late executors cannot revive terminal or invalidated actions. A fresh Core instance recovers from the ledger/observations with empty scheduler ages and cursors. Scheduler memory is unnecessary for crash correctness.

### Durable authority and ownership audit

The final source audit searched all JavaScript under `src` for timers, intervals, triggers, queues, reconcile/evaluate/plan/dispatch, pending/inFlight/promise, starting/stopping/restart, replacement/generation/reservation/action/transition. The Core/accounts/manager/lifecycle matches were then inspected by owner:

| Remaining mechanism | Owner and boundary |
|---|---|
| Trigger map, debounce/continuation timer, bounded drain, safety interval and schedule wakeup | AutonomousCore only; every trigger enters the same serialized evaluator. |
| Cycle IDs, elapsed budget, windows, attempt ages, finite revisit allowance | CycleScheduler; memory only, no operational ownership, executor or timer. |
| Observation in-flight promise | CoreObserver coalesces reads; BotManager bounds parallel fact queries and scan deadline; BotProcess owns individual IPC request/deadline/incarnation correlation. |
| Action resource claims, state, terminal immutability, startup repair | ActionLedger transaction and unique resource keys; unchanged Phase 3 durable authority. |
| Dispatch promises, acceptance-yield timers, expiry timers and execution guards | ActionCoordinator; lifecycle attempts already owned by the ledger, never an independent planner. |
| Replacement rows and generation progress | AccountReplacements executor and explicit settlement; linked to action identity. `plan()` no longer writes rows, journal or notifications. |
| Generated-account transaction and receipts | DataBaseManager/command execution and existing receipt table; tombstones prevent replay. Ambiguous DISPATCHED generation is not retried blindly. |
| Account assignment promise queue and AccountPool reservations | Existing low-level assignment serialization and account safeguards. They do not compute desired state or replace ledger claims. |
| Configuration sync interval, promise queue and deferred configuration restart timers | BotConfigurationService existing executor/configuration owner; unchanged. |
| Heartbeat, stable/reconnect timers, startingConfiguration, restartRequested, desired intent | BotManager supervisor; remains external transition coverage, not Core ownership. |
| Worker stop and command-response deadlines | BotProcess transport/process boundary, not a Core control loop. |
| Analysis sessions, retry/expiry data, planner and worker workload commands | AnalysisCoordinator/AnalysisPlanner/MarketStore and Analyst worker; explicit workload boundary, dispatch allowance supplied by the one Core cycle. |
| Worker reconnect/login, realm readiness, Anti-AFK, role/task/auction timers and Telegram authorization/binding promises | Existing runtime/transport owners; no autonomous Core evaluation authority. |
| Browser refresh/debounce, command/event dispatch and journal notifications | Presentation/transport adapters; backend policy/observation/cycle diagnostics remain authoritative. |

No competing Core controller, durable scheduler queue or supervisor arbitration layer was added. Manual ownership, policy revision guards, action resources, generation receipts, uncertain observations and `TRADING_EXECUTION_DISABLED` retain their Phase 1–3 contracts. General active Reseller STOP remains blocked; only supported idle Analyst STOP can execute.

### Diagnostics and changed files

`core.getSnapshot` exposes the active and last cycle: ID, stage/outcome, policy/input/data/observation revisions/timestamps, elapsed duration, candidate production/admission, selection/reservation/dispatch, workload dispatch, deferral, blockers/conflicts/failures, trigger counts and continuation/budget reasons. One `core.cycle.completed` summary/event is emitted per finished pass, not per polling tick or candidate scan. Existing detailed action/decision events remain unchanged.

The Ukrainian Core page renders those backend values and exposes the six supported controller settings with capability metadata. It does not recalculate selection, ownership, coverage or budgets.

| File | Purpose |
|---|---|
| src/core/cycleScheduler.js | New bounded admission, timing, age ordering and continuation helper. |
| src/core/autonomousCore.js | Explicit stages, one bounded drain, retained/coalesced triggers, startup/shutdown and diagnostics. |
| src/core/coreReconciler.js | Pure bounded inventory admission, fair bot ordering and isolated planning components. |
| src/core/accountReplacements.js | Separate explicit settlement from repeatable pure planning. |
| src/core/coreObserver.js | Bound worker scan by remaining cycle time. |
| src/core/operationsPolicy.js | Canonical controller defaults, merge and validation. |
| src/core/coreCapabilities.js | Truthful support metadata for controller settings. |
| src/core/market/analysisCoordinator.js | Bounded workload dispatch and per-bot synchronous failure isolation. |
| src/webTerminal/public/js/coreController.js | Ukrainian cycle diagnostics and controller form section. |
| src/webTerminal/public/js/operationsPolicyUi.js | Controller labels and duration/number field definitions. |
| tests/coreScheduling.test.js | 25 scheduling, integration, recovery, purity and measurement tests. |
| tests/browserSmoke.mjs | Real frontend cycle diagnostics and editable limit assertions. |
| docs/core-v2-phase4.md | This audit, implementation and verification report. |
| artifacts/migration-preview.json | Refreshed existing migration-check report from a temporary copy. |

### Local performance measurements

Measured by the final standalone Phase 4 tests using temporary SQLite databases and deterministic mock worker/executor evidence; no Minecraft connection. Durations below are observations on this machine, not service-level promises.

| Fixture | Cycle duration | Considered / selected / dispatched / deferred | Behavior |
|---|---:|---|---|
| Normal, six bots; action cap 2, candidate cap 4 | 42.711, 26.428, 29.143 ms | 4/2/2/2, 3/2/2/0, 2/2/2/0 | All six dispatch through paced follow-up passes without additional external input. |
| 1,000-bot backlog; action cap 4, candidate cap 32 | 443.485 ms (startup including initial reads 499.113 ms) | 32/4/4/28 | 33 descriptions produced; 968 inventory objects outside the window; continuation requested. |
| Six hung executors, cap 2 | 50.921, 49.755, 49.965 ms | Two selected/dispatched each pass; first pass defers two admitted-window candidates | Six durable active actions, unique resource claims, no duplicate commands after repeated reconciliation. |
| 200 distinct triggers during an active cycle | Follow-up 5.470 ms | 0/0/0/0 | 200 signals represented by 21 queued/coalesced types, overflow forces observation; maximum concurrent evaluation = 1. |
| Twelve hung executors, 50 ms budget | Timing-dependent cut at cooperative checkpoint | Fewer than twelve initial dispatches | `CYCLE_TIME_BUDGET`, event-loop heartbeat runs, later paced cycles finish admission. |

The fairness tests also cover failed reservation, one-slot alternative selection, multi-role/window rotation and a finite all-blocked inventory sweep. These are scheduler liveness tests, separate from durable execution correctness.

### Verification

Baseline before Phase 4: `npm test` — **290 passed, 0 failed, 0 cancelled, 0 skipped**, 19303.9098 ms. Existing assertions were retained; the observation-start regression was fixed in production code rather than weakening the test.

Final verification (2026-09-26):

| Command / check | Passed | Failed | Cancelled | Skipped | Duration |
|---|---:|---:|---:|---:|---:|
| `npm test` | 315 | 0 | 0 | 0 | 38403.5971 ms |
| `node --test --test-isolation=none tests/coreScheduling.test.js` | 25 | 0 | 0 | 0 | 4971.5428 ms |
| Explicit Phase 1–3 regression subset listed below | 220 | 0 | 0 | 0 | 21374.6275 ms |
| `npm run test:ui` | PASS, exit 0 | No assertion failures | Not reported | Not reported | 7.153 s tool wall time |
| Direct `node --check` on the 12 changed/new JS/MJS files | 12 files | 0 | Not applicable | 0 | 1.926 s tool wall time |
| `npm run migration:check` | PASS, exit 0 | 0 integrity/FK errors | Not applicable | Not applicable | Not separately measured |
| Final source ownership searches | Completed | No unexplained second Core evaluator found | Not applicable | Not applicable | Not measured |

The regression subset command used `node --test --test-isolation=none` with `corePolicyAuthority.test.js`, `coreObservation.test.js`, `coreActions.test.js`, `coreFoundation.test.js`, `operationsAutomation.test.js`, `operationsAccountGeneration.test.js`, `runtimeReliability.test.js`, `runtimeIncidents.test.js` and `storageMigration.test.js` under `tests/`. The complete suite additionally retains all other existing runtime, accounts, market, database, UI-helper and Telegram coverage.

Acceptance coverage includes whole-cycle limits and automatic deferred continuation; deterministic ordering and failed-candidate fairness; trigger coalescing/arrival/overflow and non-overlap; hung executor isolation; independent reservation/planning failure; transactional conflict prevention; policy invalidation and manual holds; mutation-free replacement planning; RESERVED/DISPATCHED/COMPLETED generation startup/receipt handling; legacy import and fresh-controller restart; external supervisor coverage; unsupported Reseller STOP and trading blocks; real UI diagnostics/limit fields; shutdown during evaluation and queued continuation cancellation. Existing Phase 3 tests additionally exercise atomic shared resources, terminal immutability, ambiguous generation, receipts and concurrent account reservations.

The migration preview opened the configured unified database read-only, copied it to a temporary database, and checked/migrated that copy only. Result: **schema 10, integrity `ok`, zero foreign-key errors**. Its existing `artifacts/migration-preview.json` report was refreshed. No production database migration or live bot connection was performed.

### Remaining limitations and Phase 5 boundary

- Synchronous work remains non-preemptible. Inventory snapshots and complete desired/accounting reads scale with inventory; this change bounds scheduling opportunities and cooperative continuation rather than claiming a constant-time whole-system scan. A configured budget too small for those stages can defer every dispatch and must be increased; the default is 5000 ms.
- Fairness cursors/ages and cycle diagnostics reset on process restart. Durable ownership and completion evidence do not. Retry opportunity is not guaranteed success for a permanently blocked or failing executor.
- An unprogressable inventory eventually waits for a new signal or the existing periodic safety scan. No busy retry loop or independent scheduler polling loop exists.
- Full backend status still comes from observation/transition accounting; partial candidate windows cannot certify global readiness. Deferred inventory counts are not uncovered role counts.
- Phase 1 unsupported transition spacing, health/recovery and global graceful-stop settings remain unsupported. Controller limits are separate supported settings and do not imply those executor features now exist.
- BotManager retains supervisor reconnect/restart/configuration ownership. Phase 5 must explicitly arbitrate that ownership before any transfer. Phase 4 supplies durable claims, external transition evidence, bounded admission and audit diagnostics as prerequisites only.
- No general Reseller stopping, autonomous production trading or Phase 5 arbitration was implemented.
