# Afina Core v2 — Phase 6: Operational / Workload Separation

## Ownership audit and change

Phase 5 was the starting contract. Targeted inspection covered Analyst planning/sessions/execution, Reseller cycles and transaction safety, task configuration/runner, CoreReconciler/ActionCoordinator, lifecycle/replacement ownership, worker IPC and graceful stop.

The actual conflicts were admission/result fencing and the absence of a shared execution/safety boundary. AnalysisCoordinator sent assignments directly, without checking all lifecycle claims; worker assignments lacked role-generation fencing. Analyst admission used the remaining action allowance but was outside shared candidate selection/aging. TaskRunner selected drain mechanics by inspecting role methods. No independent process-spawn authority was found in Analyst or Reseller business code.

Now LifecycleArbiter and ActionLedger retain process intent, account/bot claims, recovery and transitions. WorkloadCoordinator gates work on an already-authorized worker. WorkerWorkload exposes live execution and drain evidence through role adapters. Neither new class receives a process/account executor. Market sessions remain the sole durable Analyst workload record; worker jobs hold only execution cancellation/completion mechanics.

## Files changed

- New: `src/workloads/{workloadContract,workerWorkload}.js`, `src/core/workloadCoordinator.js`.
- Core: `src/core/autonomousCore.js`, `src/core/coreActualState.js`, `src/core/market/analysisCoordinator.js`.
- Runtime: `src/minecraftBot/taskRunner/botTaskRunner.js`, `modes/analystTask.js`, `modes/reseller/resellerTask.js` under that directory; `src/minecraftBot/worker/{botWorker,workerFacts,gracefulStop}.js`; `src/events/workerEventNormalizer.js`.
- Diagnostics: `src/webTerminal/public/js/coreController.js`.
- Tests: new `tests/coreWorkloads.test.js`; updated `tests/helpers/fixtureObservation.js`, `tests/marketIntelligence.test.js`, `tests/browserSmoke.mjs`.
- This report. No schema, migration, market model, economic execution or lifecycle permission changes.

## Contract and adapters

States are `IDLE`, `STARTING`, `RUNNING`, `DRAINING`, `COMPLETED`, `FAILED`, `CANCELLED`, `UNCERTAIN`. Common operations cover eligibility, dispatch, acceptance, progress, finish, interruption and drain. Evidence includes role/type/id, owner, incarnation, role generation, timestamps, operation, drain action, safety and failure classification. It is allowlisted and bounded before entering worker facts.

Sending IPC does not prove acceptance or completion. Analyst sessions remain planned until correlated worker evidence arrives. Completion still requires the existing observation-count/result validation. Assignments/results are fenced by session identity, process incarnation, lifecycle epoch and role generation. Active lifecycle claims, pending lifecycle intent/recovery/configuration, manual ownership, stale configuration and draining/uncertain workers block new work. A production worker without workload facts is ineligible. Legacy executor test fixtures retain their explicit compatibility path.

Analyst uses the existing planner, auction execution, cooldowns, market statistics, durable sessions and item/scope reservations. Role-generation deduplication survives a task replacement within the same worker. Worker jobs are aborted and awaited on drain; no new pending queue or lifecycle claim is created.

Reseller wraps its existing configured-role cycles. It reports idle, active operation, drain, completion/cancellation and sticky transaction uncertainty. Existing Phase 5 buyer/seller/relist/server-action uncertainty remains authoritative. Once uncertain, another cycle cannot begin. Core rejects all non-analysis dispatch with `TRADING_EXECUTION_DISABLED`; no Reseller assignment IPC listener or autonomous buy/sell/relist path was added. Existing explicitly configured Reseller execution remains the prior boundary.

## STOP and failures

STOP still follows: correlated lifecycle request → TaskRunner's common workload drain → role cleanup/safe checkpoint → safe worker acknowledgement → mechanical process stop → authoritative process absence. Analyst aborts read-only execution and waits for cleanup. Reseller lets the active operation reach its existing boundary. Uncertain results or failed cleanup refuse safe acknowledgement. Repeated drain requests do not execute cleanup twice. Workload completion and a safe ACK cannot complete the STOP ledger action; Phase 5 absence checks and manual-force/shutdown exceptions are unchanged.

Failure evidence distinguishes business/workload, role, runtime, transport/process and uncertain economic outcomes. Ordinary analysis errors, bad tasks and AFK interruption do not request restart. Recovery requests require the current incarnation plus authoritative process absence or fresh unhealthy-worker facts and go through LifecycleArbiter. The arbiter still decides permissions, backoff and execution. Stale health is insufficient.

Manual ownership and REPLACE cancel/fence Analyst sessions; late results cannot update a new generation/incarnation. Worker cleanup remains locally executable after Core cancellation so cancelled work can actually drain.

## Scheduler, persistence and diagnostics

Workload admission candidates enter the existing CycleScheduler alongside operational candidates. Its existing deterministic group aging, rotating inventory windows and candidate/action limits select them; they never enter ActionLedger reservation. Blocked diagnostic rows cannot consume every opportunity ahead of eligible workloads. Actual workload dispatch consumes the selected allowance and the combined action bound. Existing evaluator checkpoints yield during workload admission and recheck revision/ownership before dispatch. Existing continuation/coalescing owns retries; there is no new polling loop or scheduler.

Schema remains **v11**. No table, persisted cursor, timer, diagnostic row or additional pending authority was added. Session task JSON carries correlation fields. Startup cancels interrupted Analyst sessions without replay; lifecycle/generation/replacement recovery remains unchanged. Storage implementation did not change, so no separate migration command was needed; the full suite retains migration/backup/reopen regressions.

The Ukrainian workload panel renders backend role/type/id, state, owner, incarnation, times, draining, safe/unsafe/uncertain evidence, operation and reason. Stale/missing evidence is uncertain; an old completed workload cannot make a new pending session look complete. Existing facts/status/query transport carries changes without a new high-frequency event stream.

## Final crossing audit

Targeted searches covered workload/analysis/reseller/task/session/dispatch/start/stop/restart/spawn/kill/lifecycle/pending/inFlight across the affected paths:

| Crossing | Remaining authority |
|---|---|
| Core workload candidates → scheduler | Ephemeral admission only; no bot/account claim or capacity authority |
| AnalysisCoordinator → WorkloadCoordinator → assignment/cancel IPC | Existing session ownership plus fresh lifecycle/worker checks |
| Worker role `start`/`stop` → task runner | In-process execution/cleanup only, never process lifecycle |
| Runtime failure evidence → LifecycleArbiter request | Arbiter decides recovery; ordinary workload failure cannot restart |
| GracefulStop → common drain → role adapter | Correlated action/incarnation; safe evidence cannot substitute for absence |
| Reseller `lifecycleUncertain` / quiescing flags | Existing safety evidence/checkpoints, not lifecycle intent |
| CoreReconciler task/account configuration and capacity | Operational planning/execution under ActionCoordinator/Arbiter; unchanged |
| BotManager/worker process start, exit, stop and shutdown | Existing mechanical lifecycle/fatal-runtime boundaries; no workload bypass |

No unexplained policy-level lifecycle authority remains in the audited workload paths.

## Verification

All runs use temporary test databases and mocked Minecraft transports. No application/live database migration or server connection was performed.

| Final check | Result | Duration |
|---|---|---:|
| `node --test --test-isolation=none tests/coreWorkloads.test.js` | 36 passed, 0 failed/cancelled/skipped | 1623.2058 ms |
| Phase 3–5/observation/market/runtime subset | 231 passed, 0 failed/cancelled/skipped | 14462.4013 ms |
| `npm test` (one final full-suite run) | 413 passed, 0 failed/cancelled/skipped | 27557.7009 ms |
| `npm run test:ui` | Passed: 1 browser smoke, including Ukrainian workload drain/uncertainty evidence and existing UI checks | 3.9586 s shell elapsed |
| `node --check` over source/tests/scripts | 165 files passed | 6.9096 s shell elapsed |

The 231-test command includes `coreActions`, `coreObservation`, `coreScheduling`, `coreLifecycle`, `marketIntelligence` and `runtimeReliability`. These retain process-absence STOP, generation receipts, replacement idempotency, manual ownership, backoff and bounded/fair scheduler checks. New tests cover ownership separation, real Analyst execution/failure/drain, actual Reseller idle/active drain, purchase/sell/relist uncertainty, recovery evidence, incarnation/generation/epoch fencing, startup, mixed-demand fairness, combined allowances, cooperative checkpoints, coalescing and disabled trading. Browser smoke uses isolated headless Chrome, a temporary profile and an in-memory API.

## Limitations and next boundary

- Workload pause/resume is not a new public or durable API; existing Reseller pause semantics remain local. Uncertain transactions still need external resolution/operator action.
- Diagnostics are bounded observation, not a durable history for every Reseller cycle. Reseller cycle IDs and role generations are ephemeral; process incarnation fences restart. Interrupted Analyst sessions are cancelled, not resumed.
- Synchronous SQL/planning steps remain non-preemptible; cooperative budgets do not provide hard real-time deadlines.
- No live Minecraft economic correctness test, autonomous Reseller trading or Trading Intelligence was added. All previous unsupported capabilities remain unsupported.

The recommended next boundary is an explicitly specified economic workload admission/result/reconciliation contract using this separation, without lifecycle authority. Implementing or enabling that boundary requires a separate task. Phase 7 was not started.
