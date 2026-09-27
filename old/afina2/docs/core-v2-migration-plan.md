# Core v2 incremental migration plan

> **Phase 5 update — 2026-09-26:** [Lifecycle arbitration and graceful stopping](core-v2-phase5.md) now uses the shared action ledger, durable recovery state (schema v11), correlated quiescence, and truthful lifecycle settings/diagnostics. Historical lifecycle limitations below describe their original delivery. Autonomous Reseller trading remains disabled.

> **Phase 3 completed — 2026-09-25:** Phases 1–3 are implemented. See [schema v10, shared accounting, crash consistency, audit and tests](core-v2-phase3.md). Phase 4 is the next implementation phase and has not been started. Supervisor recovery ownership and safe Reseller scale-down remain deferred; prior status entries below are historical.

> **Phase 2 completed — 2026-09-25:** Phases 1 and 2 are implemented. See [Phase 2 architecture, acceptance evidence and source audit](core-v2-phase2.md). The existing 60-second safety threshold/10-second check now drives active worker verification; no additional controller or schema migration was introduced. Next authorized implementation phase is Phase 3 (durable actions/reservations); it has not been started. Original milestones and prior status below remain historical.

> **Implementation status — 2026-09-25:** Phase 1 is complete; see the [implementation report](core-v2-phase1.md) for schema v9, migration conflicts, canonical adapters, capability matrix and verification. Phases 2–7 remain unimplemented. The original plan and historical keep/refactor decisions below are preserved; the old statements describing an audit-only delivery apply to that earlier delivery.

This plan is documentation only. [Current audit](architecture-audit.md), [settings inventory](architecture-settings-inventory.md), and [target proposal](core-v2-proposal.md) distinguish existing behavior from proposed changes. No rewrite, service creation, DB migration, UI behavior change or new reconciliation timer is part of the audit delivery.

## Keep/refactor/replace decisions

| Existing module | Current responsibility / problem | Decision and rationale |
|---|---|---|
| DatabaseStore/databaseSchema/databaseMigration | transactional SQLite, revisions, legacy import | KEEP + additive schema work later; preserve tested storage/backups |
| DataBaseManager.createGeneratedAccounts/accountCredentials | transactional credential inventory creation | KEEP; add request idempotency at contract boundary, preserve credential implementation |
| AccountAssignmentService / assignAvailableAccount | serialized atomic account binding | KEEP + CLEANUP canonical eligibility/reservations; preserve uniqueness |
| AccountPool | selection/status and independent reserved Set/stats | REFACTOR shared eligibility and observation; stop divergent counts |
| CoreStore | two policies, revision/control/derived/journal persistence | REFACTOR canonical policy adapters and action state; preserve journal/history |
| operationsPolicy | validation/schedule/effective targets, many inert fields | KEEP + REFACTOR supported schema, exact boundary calculation, explicit semantics |
| corePolicy / incidentPolicy | compatibility policy mixes runtime/market/operations | SPLIT configuration domains; MIGRATE legacy operational fields |
| AutonomousCore | triggers, evaluation, execution wait, market orchestration, UI snapshot | REFACTOR bounded single-flight orchestration and consistent assessment |
| CoreActualState | revision cache and event-derived manager facts | REFACTOR fresh observation and explicit readiness/provenance |
| CoreDecisionEngine | constrained allocations, injected store-backed snapshots | KEEP + REFACTOR pure input/output and operations/workload separation |
| CoreReconciler | plan plus SQL assignment/execution and generation arithmetic | REFACTOR pure drift plan + durable action coordination; no new independent loop |
| AccountReplacements | durable ban replacement, planning side effects, private generation policy | MERGE demand/ledger ownership into reconciliation; preserve staged executor and atomic callback behavior |
| BotManager | lifecycle mechanism and autonomous identity recovery | SPLIT responsibility within existing module: retain supervision, migrate managed recovery authorization |
| BotProcess / botWorker | fork/IPC/heartbeat/stop bridge | KEEP + bounded fresh-fact/action identity contract; preserve worker isolation |
| BotConfigurationService | fingerprint/2-second sync plus optional direct restart | KEEP sync; MIGRATE restart requests into Core actions |
| AnalysisCoordinator / AnalysisPlanner | scoped observation scheduling, sessions, dispatch | KEEP + CLEANUP effective-policy consistency and workload action contract |
| MarketStore/Model/statistics/parser | real scoped observations, retention/freshness | KEEP; batch/cache observation reads |
| economicContracts PricingEngine/AllocationEngine | explicitly unavailable future interfaces | KEEP small boundary; no Trading Intelligence implementation |
| Analyst/Reseller/task runner | actual GUI/task implementation | KEEP; extend readiness/safe-stop acknowledgement only when required/tested |
| AntiAfkManager/AfkRecovery/RealmReadyGate | movement/navigation/recovery | KEEP; expose current progress/facts, preserve ownership/cancellation |
| TelegramManager/store/pools | session/binding protocol | KEEP; add fact interface only if needed for initialization visibility |
| IncidentStore/normalization | durable ban before stop, operational block | KEEP; integrate canonical eligibility and failure accounting |
| InterfaceGateway/WebSocket/QueryService/CommandService | transport and manual commands | KEEP + route coordinated intents; preserve explicit manual ownership |
| CoreController/operationsPolicyUi | editable fields and partly speculative impact/status | REFACTOR truthful backend-supported controls/assessment |
| AccountManager shell / empty unused configs | dependency holders/no observed consumer | REMOVE AFTER MIGRATION and usage verification |
| legacy policy mirrors/unprefixed trigger aliases | compatibility, uncertain external clients | REMOVE AFTER adapter telemetry and client migration |
| legacy DB inputs/backups | historical import/recovery | KEEP until deployment inventory proves retirement safe |

No evidence makes incremental migration impossible. A full rewrite would replace working protocol/storage/runtime behavior while leaving the control-plane ownership questions unresolved.

## Rollout rules

One execution owner at a time. A shadow evaluator may calculate/diff plans but must never execute alongside the existing controller. Additive schemas and explicit versioned adapters precede reader/writer cutovers. Preserve existing on/off values; never turn inert UI recovery settings into active behavior silently. Back up and validate migrations on copies; production migration requires its own reviewed implementation/deployment task. Do not use the live DB as a test fixture.

Compatibility initially accepts old commands and maps their explicit changed fields into canonical intent in one transaction. It must not rewrite unrelated role targets from stale legacy values. Responses expose canonical revision and normalized values. Legacy columns can remain readable mirrors, but cannot remain a second authoritative write path. Domain migration of runtime/role settings preserves exact effective values and hot-update semantics.

## Ordered runnable phases

### Phase 0 — evidence baseline and behavior contract

- **Affected:** audit/proposal/tests documentation, existing policy/lifecycle test specifications.
- **Preserve:** all behavior, including trading disabled and default F auto-restart off. Freeze feature work touching ownership until contracts agreed.
- **Compatibility/DB:** no schema or command changes.
- **Tests:** retain the 107 targeted tests; identify fixtures injecting foundation engines vs production defaults. Add implementation-phase acceptance tests for currently missing guarantees, initially characterization/expected blockers rather than false convergence assertions.
- **Rollback/risk:** documentation only; no runtime rollback.
- **Live validation:** record sanitized startup, policy save, spawn→realm→role timings and current placement constraints before selecting new defaults.
- **Exit:** current owners, disabled capabilities and required scenario prerequisites acknowledged.

### Phase 1 — canonical policy and truthful capability reporting

- **Affected:** coreStore/corePolicy/operationsPolicy/autonomousCore, AnalysisCoordinator, CommandService, CoreController/operationsPolicyUi; schema only if chosen domain layout requires it.
- **Preserve:** existing enabled state, targets, schedules, item constraints, runtime config and manual holds. No automatic Reseller enablement.
- **Compatibility:** adapters for core.policy.update and core.operations.update; merge only explicitly supplied fields. One master switch and replacement/generation budget authority; expose unsupported fields as unsupported instead of promising effects. Bootstrap explicit supported roles for fresh Operations policy. Eliminate hidden stale global-target validation dependency.
- **DB:** additive canonical document/domain version or initially normalize existing Operations document; retain legacy columns as read mirrors. Migrate conflicting values with an explicit deterministic report; do not guess which divergent user edit was intended.
- **Tests:** disagreeing enabled flags/targets, partial legacy target edits, Operations-only enable with Analyst observations, fresh empty role document, role unknown, validation/UI advertised capabilities, transaction revision conflicts.
- **Rollback/risk:** old binary must still read coherent mirror values; reverting without adapter-compatible values can restore conflicting authority. Keep before/after policy export.
- **Live validation:** compare effective values and UI diagnostics before/after; confirm no starts caused solely by migration.
- **Exit:** no runtime path reads a legacy operational field directly; unsupported behavior is visible.

### Phase 2 — authoritative observation and shadow desired calculation

- **Affected:** CoreActualState, BotManager/BotProcess/botWorker, roleLifecycle, account eligibility projection, MarketStore read boundaries, snapshot/query API.
- **Preserve:** old controller remains sole executor; workers keep existing lifecycle/role mechanics.
- **Compatibility:** versioned worker facts with process incarnation, loaded role/config revision, realm/work readiness and progress; old-worker facts marked incomplete, never assumed ready. Existing UI snapshot fields temporarily derived from new facts.
- **DB:** optional additive initialization/health fact persistence; no persisted worker running truth. Inventory caches still use dataRevision. No credential copying into Core snapshots.
- **Tests:** lost public events vs lost semantic IPC, independent current-state refresh, heartbeat-alive/nonready worker, process replacement late reply, bans/cooldown/reservations, bound stopped-account coverage, revision-consistent snapshots.
- **Rollback/risk:** additional IPC volume/timeout handling; preserve old messages. Shadow observation must have no command side effects.
- **Live validation:** measure full scan duration, DB statements, per-bot fact latency, readiness differences across spawn/lobby/realm/AFK and Telegram initialization.
- **Exit:** can explain every capacity count from fresh facts; shadow mismatch reports are understood.

### Phase 3 — durable transitions and one generation/assignment budget

- **Affected:** CoreReconciler, AccountReplacements, CoreStore/schema, CommandService guard contract, account assignment/generator boundary.
- **Preserve:** generator transaction and unique account binding, bans/history, existing workload data; old lifecycle authorization remains until cutover.
- **Compatibility:** bridge existing coreBotControl pending, replacement rows and analysis sessions into one action view. Define import/recovery for each nonterminal state; don't replay old applied decisions. Generate request completion is credentials committed, not account initialized.
- **DB:** additive action/request/reservation records with unique active keys and policy/effective/incarnation versions. Backfill/cancel old transitions from observation at startup, not timestamp alone. No destructive table drops.
- **Tests:** duplicate action across restart, concurrent manual/generation/replacement demands, transactional creation+request result, uncertain acceptance, queued stale guard, total/pending limits shared, accounts bound to stopped bots counted before generation, rollback after generation before start.
- **Rollback/risk:** highest risk is double execution by old/new state readers. Never run both coordinators; rollback must drain/cancel active new actions or have a tested old-version compatibility bridge.
- **Live validation:** monitor requested/created/initializing/ready counts and verify one account ID occupies exactly one inventory/transition category.
- **Exit:** no duplicate creation from retries/restart; every transition has owner, deadline and observable completion.

### Phase 4 — bounded unified controller with periodic verification

- **Affected:** AutonomousCore trigger/drain/cycle, pure DecisionEngine, effective schedule resolver, Reconciler dispatch, assessment/query snapshot.
- **Preserve:** event speed, startup evaluation, manual intent and capability restrictions. Retain 60-second full-verification default initially.
- **Compatibility:** old events wake the same queue; API exposes one assessment while retaining deprecated display aliases. Shadow planner becomes executor only after diff review; disable prior executor atomically.
- **DB:** desired documents gain input/observation/effective versions; derived documents may be regenerated. Action state from phase 3 remains.
- **Tests:** no-event startup, event storms single-flight, thrown/stalled observation/dispatch, monotonic periodic verification, missed DB/worker notifications, schedule boundary during queued await, action deadline/retry wakeups, fixed-time deterministic planning.
- **Rollback/risk:** timing changes can expose latent state assumptions; revert only with action ownership resolved. DB locking and unbounded snapshot calls must be measured.
- **Live validation:** event-loss drills on test instances, full scan cost at representative bot counts, event queue latency, desired→ready duration; show degradation rather than hangs.
- **Exit:** missed events cannot permanently prevent correct observation; no network action blocks evaluation to completion.

### Phase 5 — managed lifecycle/recovery ownership and safe scale-down

- **Affected:** BotManager recovery authorization, BotConfigurationService restart requests, CoreReconciler recovery/stop plan, worker role safe-stop/readiness contract, Q executor.
- **Preserve:** process fork/kill/heartbeat mechanism, crash safety, bans, manual ownership and worker GUI protections. Existing manual workers must have an explicit policy for reconnect during controller disablement.
- **Compatibility:** managed B retries require valid reconciler authorization; F sends change facts/restart intent instead of directly restarting. No interval with both independent recovery owners. Maintenance permits safe stop but not start. Preserve current crash timing until deliberate calibration/mapping to canonical recovery policy.
- **DB:** durable retry window/action state may be added; quarantine facts must be separate from permanent bans. Old cooldown state remains interpretable.
- **Tests:** desired10→crash→exactly10, reconnect due after maintenance/disabled/schedule change, exhausted retry and replacement, target5→2 exactly3 confirmed stops, manual hold acquired during start/stop, no account release while process remains alive, stop timeout/failure and role-safe cancellation.
- **Rollback/risk:** **highest lifecycle risk**: duplicate restarts, orphan workers, premature account reuse, interrupted trading. Rollback requires a quiescent action boundary or a tested supervisor ownership handoff.
- **Live validation:** disposable test accounts/server for disconnect/heartbeat failure, scale-down during Analyst scan and Reseller purchase/listing, blocked inventory and AFK recovery. Measure stop progress; do not infer safe cycle completion from process exit alone.
- **Exit:** B/F have no independent managed desired-capacity policy; bounded repair/degrade behavior verified.

### Phase 6 — operational/workload separation and full acceptance scenario

- **Affected:** DecisionEngine, Reconciler, Analyst/Reseller workload acceptance, economicContracts capability use, UI diagnostics.
- **Preserve:** valid configured trading constraints and explicit lack of automatic pricing/economic scaling. No Trading Intelligence implementation.
- **Compatibility:** remove coupling between Analyst availability and Reseller lifecycle only when safe startup/readiness/stop contracts pass. Existing configured workloads remain supported; missing placement/workload is an explicit blocker. A reviewed capability rollout is required, not merely deleting TRADING_EXECUTION_DISABLED.
- **DB:** generally no destructive change; workload revision/assignment records may be additive.
- **Tests:** production default engines, simultaneous 1 Analyst/10 Resellers, initially insufficient accounts, no event stream, post-convergence silent worker disappearance, missing definitions/prices/capability, min/target/max exact semantics and maximum enforcement.
- **Rollback/risk:** enabling previously blocked autonomous trading is a material behavior change; stop new launches and safely drain affected managed workers before reverting contracts.
- **Live validation:** staged low-count controlled runs before 11-worker scenario; verify account limits, no double purchase/relist, heartbeat/readiness and policy-change cancellation. Final acceptance needs valid server/realm/bot definitions and permitted workload data.
- **Exit:** required scenario passes with events dropped and with recovery limits/clear blockers under unrecoverable failures.

### Phase 7 — UI completion and legacy retirement

- **Affected:** CoreController/operationsPolicyUi, old policy columns/adapters, obsolete trigger names/configs/AccountManager wiring, docs.
- **Preserve:** history, user values, explicit manual commands and current domain settings.
- **Compatibility:** migrate clients before retiring aliases; surface revision/observation age/capability and backend assessment; remove speculative frontend lifecycle impact calculations. Domain-specific settings no longer share the operational policy form.
- **DB:** destructive removal only in a later separately backed-up migration after a full rollback window; derived caches can be rebuilt, credentials/history cannot. Keep a migration/export path for old databases.
- **Tests:** UI/API compatibility, absence of legacy consumers/writers, fresh install and each supported upgrade path, restore-from-backup exercise, historical journal rendering.
- **Rollback/risk:** dropping fields ends binary rollback without restore; defer drops independently of code cleanup.
- **Live validation:** no legacy command traffic or reads during an agreed deployment window; operator comparison of configured/effective/desired/actual/transition displays.
- **Exit:** deletion criteria below met for each item individually.

Dependencies: 0→1→2→3→4→5→6→7. Documentation/UI corrections can accompany earlier phases, but no later executor may bypass action/observation prerequisites. Each phase ends in a runnable state with one active controller and explicit capability limits.

## Test strategy before implementation

Use a fake monotonic clock, deterministic random input where needed, temporary SQLite, controllable manager/worker facts and command barriers. Separate pure-policy tests, transition integration tests, production-composition tests and controlled live validation. Preserve existing storage/runtime/Telegram suites. Do not accept a foundation-engine fixture as proof of production behavior.

| Scenario | Required assertion |
|---|---|
| Startup desired5, actual0, no events | startup observes and reserves eligible starts; periodic passes complete convergence |
| Persisted Analyst1/Reseller10 | production configuration reaches exact ready role counts with valid prerequisites; no event needed |
| Actual changes without event | periodic independent fact refresh detects drift and exactly one repair |
| Policy3→5 | epoch changes immediately, two unreserved starts only |
| Scale-down5→2 | exactly three selected safe stops; completion only on observed exit; no account reuse early |
| Worker crash desired5/actual5 | one replacement/restart slot, never six through B+Core concurrency |
| Stale STARTING with/without heartbeat | deadline resolves transition; live heartbeat doesn't imply progress; bounded retries then degraded |
| Generation deficit | bound eligible stopped accounts, then free accounts, then uncreated reservations, then new creation |
| Generation failure/unknown result | no storm; transaction outcome recovered; failed reservation/backoff explicit |
| Duplicate delivery/restart | same idempotency key returns same action/account result |
| Schedule/DST/overnight | exact window policy; queued old-window start rejected without requiring policy edit |
| Maintenance | no start/generate/replace; safe managed drain allowed; B/F cannot relaunch |
| Manual intent during await | ownership invalidates queued Core work; safety still dominates |
| Banned/quarantined account | never selected; expiry handled only for temporary quarantine; permanent ban unchanged |
| Revision changes at each await | no obsolete irreversible action; created accounts retained if subsequent start cancelled |
| Lost analysis idle/ready event | full worker facts recover truth; stale incarnation result rejected |
| Hung command/DB observation failure | bounded controller cycle; ERROR/DEGRADED plus next retry, no overlapping executor |
| Resource/role/workload absent | explicit blocker; do not generate accounts endlessly for missing bot definitions |
| UI assessment | one backend state/revision; zero planned actions with deficit is not stable |
| Migration restart mid-transition | observe/cancel/recover actions, no duplicate worker/account generation |

Property checks: generated/pending sets disjoint; one account claim; autonomous occupied slots <=maximum; all nonterminal actions have deadlines; pure function repeats deterministic output; repeating snapshot causes no extra dispatch. Load tests measure query count/latency for repeated snapshots and verify event coalescing does not starve periodic refresh. Live tests exercise Mineflayer/GUI readiness and safe-stop assumptions that unit mocks cannot establish.

## Highest risks and deletion gates

Highest risks are lifecycle ownership transfer while reconnect timers are armed; task/configuration changes during trading; shared replacement/reserve accounting; policy adapters accidentally enabling automation or resetting another role; and treating persisted pending state as live process truth after restart. Current 107 passing tests protect useful local behavior but do not cover these target invariants.

Delete a legacy field/path only when: all readers/writers identified and migrated; canonical-value conflict handling tested; old-client compatibility window closed; code search finds no production consumer; replacement tests use real production wiring; metrics/live validation show no duplicate actions or stranded transitions; rollback/export is tested; and historical records still render. Delete obsolete DB inputs only after verifying completed imports and independent backups. Do not remove the Reseller safety gate until phase 6 acceptance; do not activate inert recovery settings simply because their fields already exist.

The architecture review is the final artifact of this task. Implementation should begin only in a subsequent authorized task after review of these contracts and migration risks.
