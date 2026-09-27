# Core v2 Phase 1 — current implementation

> **Phase 5 update — 2026-09-26:** [Lifecycle arbitration and graceful stopping](core-v2-phase5.md) now uses the shared action ledger, durable recovery state (schema v11), correlated quiescence, and truthful lifecycle settings/diagnostics. Historical lifecycle limitations below describe their original delivery. Autonomous Reseller trading remains disabled.

> **Current rollout:** [Phase 3 actions/shared accounting](core-v2-phase3.md) is now implemented in schema v10. The policy contract below remains valid; historical schema and later-phase status statements describe the Phase 1 delivery.

Implemented on 2026-09-25. This is the current policy contract, superseding the policy-authority findings in the historical [audit](architecture-audit.md) and [inventory](architecture-settings-inventory.md). [Phase 2 authoritative observation](core-v2-phase2.md) is now implemented; Phases 3–7 in the [migration plan](core-v2-migration-plan.md) remain future work. Production autonomous Reseller trading remains blocked. Verification and observation limitations below describe the Phase 1 delivery baseline; the Phase 2 report records its subsequent changes.

## Canonical authority and response contract

`operationsPolicy.document` is the only persisted operational authority. `CoreStore.operationsPolicy()` normalizes that document; `effectiveOperationsPolicy()` resolves schedules, enabled roles, deterministic priority clipping, maintenance, startup hold, capabilities and permissions. AutonomousCore, CoreDecisionEngine, CoreReconciler, AccountReplacements and AnalysisCoordinator consume `policy.operations`, the effective representation. Item constraints and existing per-bot manual holds remain additional execution guards.

The supported operational shape is below. Numbers are safe fresh-install defaults, not deployment values. `capacity.target` is a derived compatibility alias. Read-only compatibility properties are retained in the document in addition to these fields.

```json
{
  "automationEnabled": false,
  "allocationEnabled": true,
  "maintenanceMode": false,
  "timezone": "Europe/Oslo",
  "startupPolicy": "restoreDesiredState",
  "capacity": {"minimum": 0, "target": 0, "maximum": 0},
  "roles": {
    "analyst": {"enabled": true, "minimum": 0, "target": 0, "maximum": 0, "priority": 100, "autoStart": true, "autoReplace": true, "stopMode": "graceful"},
    "reseller": {"enabled": true, "minimum": 0, "target": 0, "maximum": 0, "priority": 80, "autoStart": true, "autoReplace": true, "stopMode": "graceful"}
  },
  "schedules": [],
  "recovery": {"autoReplaceBannedAccounts": false},
  "reserve": {
    "minimumReadyAccounts": 0,
    "targetReadyAccounts": 0,
    "automaticAccountGeneration": false,
    "maximumTotalAccounts": 0,
    "maximumPendingAccountGeneration": 1
  }
}
```

The real recovery object also retains the old restart settings. Transition, stability and health objects retain their old defaults/values. Role-specific autoStart/autoReplace/stopMode and all capacity/reserve minima have no independent executor. Minima remain nonnegative stored values, but no longer prevent lowering a supported target below an inert minimum. Role targets must remain within their role maximum. The global maximum clips effective role targets, ordered by descending priority then role identifier. A stored global target is ignored and re-derived during normalization, so a stale value cannot reject a valid edit.

Unknown role definitions can be preserved if structurally valid. They are explicitly `UNSUPPORTED_OPERATIONAL_ROLE`, read-only in the UI, and never executable. Their old capacity-envelope participation is retained conservatively; inspect or remove them through an explicit API policy edit if they consume capacity. Fresh installs always include Analyst and Reseller.

`core.getSnapshot` retains old fields and adds `configuredPolicy`, `canonicalRevision`, `policyMetadata`, `canonicalization`, `domains`, `automation`, `capabilityBlockers`, `assessmentPending`, and `assessmentPolicyRevision`. Effective roles carry configured/scheduled/effective targets, reasons, `supportedRole`, `executable` and `blocker`. Desired state is not an execution guarantee. A newly committed policy is reported as awaiting evaluation instead of inheriting the previous policy's stable assessment. Reconciliation retains its evaluated policy revision.

Named permissions gate existing behavior only: mayStart, mayStopManaged (currently only the existing idle-Analyst stop path), mayGenerate, mayReplace and mayDispatchWork. They do not implement safe draining or authorize supervisor recovery. Manual holds, task validity, pending actions and revision guards remain checked by existing executors.

## Compatibility mapping

`core.policy.update` remains supported. Only supplied aliases are adapted. Non-operational edits cannot reconstruct operational intent from SQL mirrors. Both update APIs return canonical state and canonical revision; the legacy `policy` response remains a canonical projection for old clients.

| Legacy field | Canonical field | Compatibility behavior | Removal |
|---|---|---|---|
| enabled | automationEnabled | Explicit write maps switch; read is canonical projection | Phase 7, after client migration |
| targetAnalysts | roles.analyst.target | Changes only this role; raises its role maximum if required, preserves global maximum and other role | Phase 7 |
| targetResellers | roles.reseller.target | Same role-local adaptation; effective target still clipped | Phase 7 |
| autoAllocateBots | allocationEnabled | Preserves existing allocation gate | Phase 7 |
| autoReplaceBannedAccounts | recovery.autoReplaceBannedAccounts | One explicit replacement permission | Phase 7 |
| allowAutomaticAccountGeneration | reserve.automaticAccountGeneration | One permission for both existing autonomous generation paths | Phase 7 |
| maxAccounts | reserve.maximumTotalAccounts | One total limit; zero forbids autonomous creation | Phase 7 |
| capacity.target | derived effective role total | Input is ignored; normalized read is derived | Phase 7 |

Legacy target edits cannot raise the global ceiling. A fresh installation has ceiling zero: set an explicit Operations maximum before expecting a legacy target edit to produce work. SQL target mirrors retain their original 0..1000 constraints and are clamped for larger canonical targets; API aliases remain exact. No production planner reads these SQL aliases.

CoreStore writes runtime settings, compatibility mirrors and the canonical document in one transaction. One Operations write increments its revision once and triggers one coreMetadata input revision. The old `revision_corePolicy_UPDATE` trigger is removed to avoid independent policy epochs. Core update methods queue one evaluation per successful logical edit; existing lifecycle/DB events can independently cause subsequent reconciliations. Runtime-only saves also increment the canonical revision once. Override edits remain separate workload input revisions.

## Capability and functional settings inventory

The central registry is `src/core/coreCapabilities.js`. `policySettingMetadata` covers every current Core field, override field and Operations leaf. Ukrainian help explains scope, consumer and limitations. The normal Operations form has one master switch and one target control per supported role. Inert settings and Core compatibility aliases are disabled in collapsed compatibility sections. The runtime form submits only changed editable fields; disabled legacy values cannot overwrite a newer operational target.

| Feature / settings | Status | Real consumer and current behavior | Limit / blocker |
|---|---|---|---|
| Analyst target / allocation | Supported executor; partial capacity policy | CoreReconciler starts eligible configured bots; AnalysisCoordinator dispatches analysis when autoAnalysis is enabled; idle excess Analysts can stop | Busy/manual/pending/unready bots can prevent convergence; no bot-definition creation |
| Reseller lifecycle / target | Partial | DecisionEngine computes intent; AccountReplacements preserves existing banned-account replacement | Ordinary autonomous assignment and scale-down blocked |
| Autonomous Reseller trading | Unsupported | CoreReconciler retains production gate | TRADING_EXECUTION_DISABLED |
| Automatic account generation / reserve | Supported | Reconciler → accounts.generate; replacements → existing transactional createGeneratedAccounts | Permission, existing ready accounts first, remaining demand, pending/total limits, retry backoff |
| Banned-account replacement | Supported | Existing AccountReplacements staged executor, assignment and readiness handling | Canonical permission, needed workload, manual hold, eligible account or generation permission/budget |
| Role enabled/target/maximum/priority; global maximum | Partial | Effective policy clips intent deterministically | Priority is not account-assignment order; maximum does not forcibly stop active bots |
| Schedules / timezone | Partial | Existing server-side resolver and wakeup | Changes effective intent; lifecycle capability still limits convergence; existing boundary scan unchanged |
| Maintenance | Partial | Effective policy zeros role targets and blocks new autonomous Core actions/analysis | MAINTENANCE_DRAIN_UNSUPPORTED; running bots and supervisor retries continue |
| startupPolicy | Supported gate | AutonomousCore startup latch; Operations save releases keepStopped | No supervisor ownership transfer |
| Graceful / finishCurrentCycle stop | Unsupported | No general managed executor | SAFE_TRANSITION_UNAVAILABLE |
| Managed restart policy | Unsupported | BotManager recovery still uses its own fixed rules | MANAGED_RESTART_POLICY_UNSUPPORTED |
| Health / automatic quarantine | Unsupported | No policy-driven executor; manual blocks and ban persistence still work | HEALTH_AUTOMATION_UNSUPPORTED |
| Role autoStart / autoReplace; transition / stability settings; capacity/reserve minima | Unsupported | Stored compatibility only | Not active controls; do not gate existing executors |
| Automatic pricing | Unsupported | Production pricing provider unavailable | No Trading Intelligence activation |
| Market / Analyst strategy | Separate domain | AnalysisPlanner/Coordinator/MarketStore | Shares canonical automation; no independent operations switch |
| Anti-AFK / realm readiness | Separate runtime domain | Existing runtime configuration, AntiAfkManager, RealmReadyGate | Hot updates preserved; no capacity ownership |
| Item overrides / allocation constraints | Partial workload domain | DecisionEngine, AnalysisPlanner, AccountReplacements as applicable | Cannot activate trading, exceed role/global limits or bypass manual hold |
| Debounce, safety interval, journal, failure/timeout | Separate controller domain | Existing AutonomousCore/CoreStore mechanisms | Default 60-second safety threshold, checked every 10 seconds, retained |
| DB, supervisor internals, Telegram, captcha | Infrastructure | Existing services and configuration | No ownership migration in Phase 1 |

Creation produces stored credentials/account inventory, not proof of remote registration or realm readiness. Existing replacement requests already own logical work demand, including initialization/retry, so ordinary generation excludes those slots and cannot create duplicate accounts for them. Ordinary generation also rechecks the shared budget at execution and at the existing command guard, so prior replacement creation cannot overrun the total limit. A changed budget blocks that action without generator-failure backoff. The two existing paths use one allowance calculation and the existing pending counts; no unified reservation ledger was added. The old generator, credential factory, assignment transaction, durable ban records and staged replacement initialization remain intact.

## Migration and rollback

SQLite schema version is **9**. The migration adds `operationsPolicy.canonicalization` containing source, migration revision, conflict diagnostics and the complete original Operations document plus original operational legacy fields. It normalizes the existing Operations document and refreshes compatibility mirrors; no legacy columns, history, credentials, tasks or bindings are dropped.

Deterministic v8 conversion rules:

1. A nonempty Operations document was the existing Core cycle's switch/target authority, so retain it. Empty document means old-only policy: import legacy switch/role targets, role maxima and their summed global maximum. Defaults are safe and include both supported roles.
2. Replacement's old Operations flag was inert. Preserve the legacy flag actually used by the replacement executor, even when the inert stored flag disagreed. Preserve the actual legacy allocation gate as canonical allocationEnabled.
3. If replacement was enabled, the two generation paths had competing permissions/limits. Require both old permissions and choose the smaller total limit. Old-only state uses the disabled default Operations generation path in this conservative intersection. This may restrict formerly permitted replacement generation; diagnostics require an explicit canonical edit to permit it again. It never broadens an inert generation permission merely through migration.
4. If Operations was configured and replacement was disabled, retain its existing ordinary generation permission/limit. Do not activate replacement using its previously inert flag.
5. Conflicts include field, canonical/legacy values, resolution and migration revision. Originals remain archived even when no conflict is emitted. Unsupported values remain persisted and inert.

Migration runs transactionally after an automatic `backups/<timestamp>-v9/afina-before-v9.db` backup and verifies foreign keys and SQLite integrity. Reopening version 9 performs no normalization write or second backup. Migration imports policy only; it never calls executors. Normal subsequent startup retains existing evaluation behavior and trading gates. Fresh policy remains disabled. Startup emits one canonicalization summary and the stored conflicts; routine evaluations do not repeat these diagnostics. Explicit legacy API use emits `CORE_LEGACY_POLICY_ADAPTER_USED` with field names and revision, without credentials.

Rollback requires stopping the application, restoring the complete pre-v9 backup and matching old application code. Older versions intentionally reject a newer schema. Do not roll back by modifying user_version or only copying legacy mirrors. No live database was read, migrated, or used as a fixture during this implementation.

## Removed conflicts and remaining work

Removed: independent legacy switch/role target reads; Core-vs-AnalysisCoordinator enable mismatch; private replacement permission and generation limit; Operations-vs-legacy generation authority; editable legacy master/target UI controls; hidden-field writes during runtime saves; global capacity.target authority; duplicate policy revision trigger effects; unsupported controls presented as active; stable production reporting for impossible Reseller intent.

Intentionally remaining: event-derived/cached runtime facts can be stale; no worker fact polling or incarnation reconciliation; current Core can await execution; supervisor reconnect/crash recovery and worker runtime recovery still own independent mechanics; replacement planning still has existing settlement side effects; no durable action ledger/unified reservations; inventory eligibility/readiness counts are not a unified observation model; general safe stopping and health automation are unavailable. Existing schedule minute scanning/wakeup behavior remains; only the no-enabled-schedules case skips a provably unnecessary scan. No second loop was added.

Phase 2 can now consume canonical configured/effective policy, capability metadata, revisioned desired state, existing actual projection and explicit configured/effective/executable differences. There is no Phase 1 authority blocker to starting Phase 2. Phase 2 must supply fresh authoritative worker facts, incarnation/provenance and lost-event repair rather than treating the current projection as authoritative. Phase 3 still owns durable actions/shared reservations; Phase 4 bounded reconciliation; Phase 5 managed recovery and safe stopping; Phase 6 fuller workload separation/acceptance; Phase 7 final UI and legacy retirement. This task implements none of those later mechanisms.

## Changed files

| Files | Purpose |
|---|---|
| src/core/canonicalPolicy.js (new) | Legacy adapters, migration resolution, shared generation allowance |
| src/core/coreCapabilities.js (new) | Capability and every-setting metadata/domain registry |
| src/core/operationsPolicy.js | Supported role defaults, derived totals, effective contract/reasons/permissions |
| src/core/coreStore.js | Canonical reads, runtime projection, atomic writes and mirrors |
| src/core/autonomousCore.js | Canonical composition, snapshot/diagnostics, revision/evaluation integration |
| src/core/coreDecisionEngine.js, coreReconciler.js, accountReplacements.js | Effective operational consumers; preserve executor mechanics and avoid duplicate replacement demand |
| src/core/market/analysisCoordinator.js | Canonical automation for dispatch and incoming results |
| src/core/corePolicy.js | Ukrainian legacy/pricing labels |
| src/data/databaseSchema.js, databaseMigration.js | Additive v9 migration and single revision trigger |
| src/webTerminal/public/js/coreController.js, operationsPolicyUi.js | Truthful controls/help/domains, capability display and explicit runtime-only saves |
| tests/corePolicyAuthority.test.js (new) | Nine migration, authority, budget and metadata regressions |
| tests/marketIntelligence.test.js | Three production authority/revision/blocker tests and production assertions |
| tests/coreFoundation.test.js, runtimeIncidents.test.js, runtimeReliability.test.js | Explicit canonical fixture ceilings; effective-policy test contract; shared execution-time generation budget regression |
| tests/operationsAutomation.test.js | Derived global target validation contract |
| tests/storageMigration.test.js, telegram.test.js | Expected v9 version and backup name |
| tests/browserSmoke.mjs | Real UI compatibility, capability, conflict and save regression checks |
| docs/core-v2-phase1.md, architecture-audit.md, architecture-settings-inventory.md, core-v2-proposal.md, core-v2-migration-plan.md, core-foundation.md, operations-automation.md | Current implementation report and historical audit addenda |

## Verification

Baseline `npm test`: **231 passed, 0 failed**. Final `npm test`: **244 passed, 0 failed** (includes nine new authority/migration tests, three new production-composition tests and one execution-time shared-budget regression). Existing generation, replacement, ban, runtime, storage, Market, Telegram and configuration suites remain included.

Focused `node --test --test-isolation=none tests/coreFoundation.test.js tests/marketIntelligence.test.js tests/operationsAccountGeneration.test.js tests/runtimeIncidents.test.js`: **101 passed, 0 failed**, before adding the three new production tests. `node --test --test-isolation=none tests/corePolicyAuthority.test.js`: **9 passed, 0 failed**.

`npm run test:ui`: **1 smoke scenario passed**, no JavaScript exceptions. Real frontend, in-memory API, isolated headless Chrome profile; Ukrainian help, compatibility controls, configured/effective/capability rendering, stale revision rejection, runtime-save isolation, reload persistence and responsive layout. Chrome required execution outside the process-spawn sandbox; it did not use the user's browser profile or application DB. Screenshots are generated in artifacts/ by the existing test.

Migration fixtures cover old-only, Operations-only, conflicting and fresh states, complete v8 backups, preservation of credentials, zero executor journal entries, integrity_check=ok, no FK errors, and idempotent reopen. The live-config migration preview script was deliberately not used as a fixture.

Final source search classification: operational `legacy.*` reads exist only in canonicalPolicy migration; seven flat field names in coreCapabilities/corePolicy/incidentPolicy/databaseSchema are adapter maps, descriptors or historical schema/migration; CoreStore.policy is a canonical compatibility projection used for snapshots, API before/after and validation. No downstream planner reads flat legacy operational values. Runtime generation and replacement permission reads occur only under the effective operations object/shared allowance. Browser disabled legacy fields are compatibility display; tests intentionally exercise old clients and poisoned SQL mirrors.
