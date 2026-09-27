# Settings ownership inventory (current implementation)

> **Phase 5 update — 2026-09-26:** [Lifecycle arbitration and graceful stopping](core-v2-phase5.md) now uses the shared action ledger, durable recovery state (schema v11), correlated quiescence, and truthful lifecycle settings/diagnostics. Historical lifecycle limitations below describe their original delivery. Autonomous Reseller trading remains disabled.

> **Phase 3 update — 2026-09-25:** [Action deadlines/accounting](core-v2-phase3.md) reuse `actionTimeoutMs` (default 60 seconds), `failureRetryMs` (default 60 seconds) and `journalLimit` (default 1000). The ledger supplies shared uncreated quantities to canonical generation limits. No new operational policy authority or supported recovery setting was introduced. The 10 ms dispatcher yield is internal; schema is v10.

> **Phase 2 observation addendum — 2026-09-25:** [Observation freshness and timeout contract](core-v2-phase2.md) adds internal, validated read-side defaults: freshness 15 seconds, request timeout 1 second, concurrency 32, scan deadline 3 seconds. These are not new DB settings or operational policy authorities. The existing safety interval remains default 60 seconds, checked every 10 seconds, independently of event evaluations. Unsupported recovery/transition fields remain unsupported; schema remains v9.

> **Phase 1 functional-status addendum — 2026-09-25:** The detailed tables below describe the historical audit baseline. Current field-by-field status is returned by `policyMetadata` from `src/core/coreCapabilities.js`; the [current inventory and mappings](core-v2-phase1.md#capability-and-functional-settings-inventory) supersede the old writer/authority columns. Seven legacy operational fields are adapters/read-only UI projections. Global target is derived; minima, role autoStart/autoReplace/stopMode, transition, stability, restart and health controls remain stored but unsupported. Runtime, market, workload and controller settings have explicit domain projections. Only canonical recovery.autoReplaceBannedAccounts is an executable recovery-policy field.

Companion to [architecture audit](architecture-audit.md). This inventory covers every leaf in `policyFields`, `overrideFields`, and the Operations document, plus lifecycle settings outside those policies. Defaults describe a fresh schema/default object, not the user's live database. No secrets or live values were read. Unknown arbitrary database-defined role setting names are not invented as Core settings.

## Matrix conventions and common ownership

| Prefix | UI location / persisted field | Writer / validator | Readers and wakeup |
|---|---|---|---|
| C | Core policy form, `corePolicy.<field>` SQL column | `CoreController.savePolicy` → `core.policy.update` → AutonomousCore.updatePolicy → CoreStore.updatePolicy; `validateFields(policyFields)`, SQL checks, `validateMarketPolicy`, `validateAntiAfk` | CoreStore.policy, AutonomousCore, consumers below. Every accepted update schedules evaluation and increments coreMetadata; antiAfk updates also broadcast runtime:configure |
| O | Core Operations form, `operationsPolicy.document.<path>` JSON | `saveOperations` → `core.operations.update` → updateOperationsPolicy → CoreStore; mergeOperationsPolicy/validateOperationsPolicy | effectiveOperationsPolicy, AutonomousCore, UI; every save increments Operations and Core revisions, clears keepStopped latch, schedules evaluation, even for inert fields |
| I | Core item override form, `coreItemOverrides.<field>` per item | core.override.set/delete → CoreStore; validateOverride + SQL | DecisionEngine, Reconciler, AnalysisPlanner, AccountReplacements; all changes wake evaluation and invalidate generation |

Thus “wake=yes” applies to **every C/O/I row**, even when runtime effect is absent. It means reevaluation, not that the field is functionally implemented. Readers listed below are execution/decision readers beyond persistence, validation and UI. C form is descriptor-generated: enabled/targetResellers/targetAnalysts are in a collapsed legacy compatibility section, runtime fields in Anti-AFK, market/analysis fields in advanced Market/Analyst; remaining fields are ordinary Core policy controls. All descriptors, including collapsed legacy values, are submitted on every Core form save. O section follows the first path segment. I fields share the item form. Legacy/Duplicate flags: `L` compatibility/legacy, `D` overlapping authoritative concept, `—` neither identified, `P` planned/inert. These are current-code findings, not approval to delete.

Validation notation: `b` boolean; `i[a,b]` integer inclusive; `n[a,b]` finite number; `dur` integer 0..2,592,000,000 ms; `cap` triple integers 0..1,000,000 with minimum<=target<=maximum. Operations validation strictly checks top-level keys but does not uniformly reject unknown nested keys; stability validates enumerated supplied values and does not enforce an exact required-key schema. Defaults alone are not proof of consumer support.

## Core fields

| C field | Default | Validator | Runtime consumer / effect | L/D | Functional? |
|---|---:|---|---|---|---|
| enabled | false | b | A legacy compatibility, M.handle, snapshot status | L,D | partial; not sole master switch |
| targetResellers | 0 | i[0,1000] | legacy fallback/canonical rewrite, D/R compatibility policy | L,D | partial; Operations normally authoritative; trading blocked |
| targetAnalysts | 0 | i[0,1000] | same for Analyst | L,D | yes via compatibility; duplicate authority |
| maxResellersPerItem | 3 | i[1,1000] | D allocation hard limit | — | planning yes, ordinary production trading execution no |
| autoAllocateBots | true | b | R gates assignment/Analyst stop | D | yes; additional global gate beyond Operations |
| autoSelectItems | false | b | D fills spare allocation from configured priced items by itemId | — | planning yes; no economic ranking |
| autoPricing | false | b | D calls PricingEngine.quote (returns null), emits unavailable assessment | P | no pricing provider |
| autoAnalysis | false | b | M dispatch and acceptance; D analysis hint | — | yes, subject to enabled mismatch |
| minimumAssignmentDurationMs | 300000 | i[0,604800000] | R product switching constraint | — | foundation/stopped assignment path only |
| switchCooldownMs | 300000 | i[0,604800000] | R product switch cooldown | — | same, not lifecycle stability |
| switchImprovementThresholdPercent | 10 | n[0,1000] | R requires measured improvement for non-hard product switch | P | guard works, allocation provider has no real improvement proposal |
| decisionDebounceMs | 250 | i[20,10000] | A.schedule timer | — | yes |
| safetyIntervalMs | 60000 | i[10000,600000] | A 10-second check since last completed cycle | — | yes unless drain blocked |
| journalLimit | 1000 | i[50,10000] | S.decision retention, protects active referenced decisions | — | yes |
| failureRetryMs | 60000 | i[1000,3600000] | assignment/generation/Q failure backoff; AnalysisPlanner failed session retry | — | yes, multiple domains coupled |
| actionTimeoutMs | 60000 | i[1000,600000] | A pending assignment, Q initialization settlement | — | partial; no whole-apply timeout or cancellation |
| autoReplaceBannedAccounts | false | b | Q.plan/apply permits banned replacement | D | yes, independent of O equivalent |
| allowAutomaticAccountGeneration | false | b | Q.apply generation only | D | yes, not ordinary reserve generation |
| maxAccounts | 0 | i[0,1000000] | Q.apply total row ceiling, zero prohibits | D | yes, not shared global budget |

Sources: [corePolicy.js](../src/core/corePolicy.js), [incidentPolicy.js](../src/incidents/incidentPolicy.js), [databaseSchema.js](../src/data/databaseSchema.js) createCoreSchema / upgradeToVersion7; consumer symbols A/D/R/Q/S defined in audit.

## Market and Analyst fields in Core policy

All rows C, L/D=`—`, functional yes. Values are descriptor defaults added as SQL defaults by schema upgrades. Validation is validateFields plus cross-field checks: min observations<=max; fresh<stale; retail<medium; worst-case realm/window/refresh duration<=session timeout. A save wakes Core, while worker tasks receive a timing snapshot; it does not mutate an already executing task in place.

| C field | Default | Validator | Reader / runtime effect |
|---|---:|---|---|
| analysisRealmReadyDelayMs | 15000 | i[0,300000] | AnalysisPlanner task timing → analystExecution/RealmReadyGate |
| analysisRealmReadyDelayJitterMs | 3000 | i[0,60000] | same readiness random addition |
| analysisMinObservations | 3 | i[1,20] | AnalysisPlanner.rank observation count |
| analysisMaxObservations | 5 | i[1,20] | same for low confidence/new/volatile markets |
| analysisRefreshIntervalMs | 5000 | i[5000,60000] | task timing → Analyst GUI refresh minimum |
| analysisRefreshJitterMs | 1500 | i[100,10000] | task timing → randomized refresh spacing |
| analysisWindowTimeoutMs | 15000 | i[1000,60000] | task timing → auction GUI waits |
| analysisSessionTimeoutMs | 240000 | i[30000,3600000] | MarketStore session deadline; M checks timeout |
| analysisMinRepeatMs | 60000 | i[10000,3600000] | AnalysisPlanner rank retryAt after completed session |
| marketFreshMs | 300000 | i[10000,3600000] | MarketStore snapshot freshness |
| marketStaleMs | 1800000 | i[20000,86400000] | snapshot freshness; AnalysisPlanner age score |
| marketRetailMaxAmount | 4 | i[1,1024] | marketStatistics lot segmentation |
| marketMediumMaxAmount | 16 | i[2,4096] | marketStatistics lot segmentation |
| marketRawRetentionHours | 24 | i[1,720] | MarketStore.cleanup raw retention |
| marketHistoryRetentionHours | 168 | i[1,2160] | MarketStore.cleanup aggregate retention |
| marketRawLimit | 5000 | i[100,100000] | MarketStore.cleanup raw count cap |
| marketHistoryLimit | 20000 | i[100,200000] | MarketStore.cleanup history cap |

Source: [marketConfig.js](../src/core/market/marketConfig.js), [analysisPlanner.js](../src/core/market/analysisPlanner.js), [marketStore.js](../src/core/market/marketStore.js), [marketStatistics.js](../src/core/market/marketStatistics.js). Auction window type/slots, max listings 5 and minimum refresh 5000 in `auctionConstraints` are execution constants, not user Core policy.

## Runtime tuning currently inside Core policy

All C, functional yes, L/D=`—` except overlapping readiness domains described in audit. A broadcasts on update; F.prepare supplies runtimeConfig on startup; worker configures AntiAfkManager. Validation: field bounds below plus maxInterval>=minInterval. These should move domains without changing movement implementation.

| C field | Default | Validator | Effect |
|---|---:|---|---|
| antiAfkEnabled | true | b | prevention eligibility |
| antiAfkMinIntervalMs | 35000 | i[1,3600000] | random activity deadline lower bound |
| antiAfkMaxIntervalMs | 50000 | i[1,3600000] | deadline upper bound |
| antiAfkForwardBlocks | 2 | n[0.1,16] | forward movement distance |
| antiAfkBackwardBlocks | 2 | n[0.1,16] | backward distance |
| antiAfkMovementTimeoutMs | 10000 | i[1,60000] | abort movement duration |
| antiAfkRetryDelayMs | 5000 | i[0,60000] | retry/defer delay (busy floor 100 ms) |

Source: [runtimeConfig.js](../src/minecraftBot/runtime/runtimeConfig.js), [antiAfkManager.js](../src/minecraftBot/runtime/antiAfkManager.js), A.updatePolicy, F.prepare.

## Item overrides

All I. Nullable numeric defaults are null; disabled default false. Partial updates merge then validate min<=max, min<=forced<=max where present. Duplicate flag refers to workload constraints also present in tasks, not a second role-capacity source.

| I field | Default | Validator | Consumer / effect | L/D | Functional? |
|---|---|---|---|---|---|
| disabled | false | b | D zero item allocation, AnalysisPlanner excludes item, Q desired item deficit | — | yes planning/analysis/replacement |
| minBots | null | nullable i[0,1000] | D minimum allocation subject to total/item maximum | — | planning yes |
| maxBots | null | nullable i[0,1000] | D per-item ceiling | — | planning yes |
| forcedBots | null | nullable i[0,1000] | D exact requested allocation, clipped and explained on conflict | — | planning yes |
| maxBuyPrice | null | nullable n[0.000001,1e15] | D price eligibility, Q workload recheck | D | yes constraints, no auto price computation |
| minSellPrice | null | nullable n[0.000001,1e15] | same sell floor | D | yes constraints |

## Operations identity, capacity, role and schedule settings

Default roles are **empty**, not implicit Analyst/Reseller entries. Only legacy updatePolicy bootstrap synthesizes role entries: enabled=true, minimum=0, target=legacy target, maximum=target, priority Analyst=100/Reseller=80, autoStart=true, autoReplace=true, stopMode=graceful. UI iterates existing roles and has no automatic role bootstrap in loadOperations. This can leave a fresh Operations form with no role controls until compatibility initialization or API configuration.

| O path | Default | Validator | Consumer / actual effect | L/D | Functional? |
|---|---|---|---|---|---|
| automationEnabled | false | b | O.automationActive → A cycle | D | partial; base enabled still consumed elsewhere |
| maintenanceMode | false | b | O disables automation; A sets zero targets | — | blocks new Core actions; does not drain/revoke B retries |
| timezone | Europe/Oslo | Intl IANA zone | O schedule calculation | — | yes |
| startupPolicy | restoreDesiredState | restoreDesiredState/keepStopped | A.start latch, cleared by Operations save | — | yes |
| capacity.minimum | 0 | cap | validation/UI only | P | no health/repair priority |
| capacity.target | 0 | cap | validated/stored, overwritten in effective result; hidden retained UI value | D,L | not a runtime target |
| capacity.maximum | 0 | cap | O clips role targets by priority | — | planning yes, running enforcement incomplete |
| roles.*.enabled | absent | b | O zero triple, schedule may override | — | effective target yes; stop execution incomplete |
| roles.*.minimum | absent | cap | O clamps; diagnostics | P | no minimum-health semantics |
| roles.*.target | absent | cap | O → A/D desired Analyst/Reseller | D | Analyst yes, Reseller ordinary execution blocked |
| roles.*.maximum | absent | cap | O bounds targets | — | target bound yes; no separate running ceiling |
| roles.*.priority | absent | i[0,1000000] | O chooses global-max distribution | — | yes for clipping, not account assignment ordering |
| roles.*.autoStart | absent | b | none beyond storage/effective copy/UI | P | no |
| roles.*.autoReplace | absent | b | none beyond storage/effective copy/UI | P,D | no |
| roles.*.stopMode | absent | immediate/graceful/finishCurrentCycle | none beyond storage/UI | P,D | no |
| schedules | [] | array of window records | O stateAt/findNextTransition | — | yes effective policy only |
| schedules[].id | no row | unique nonempty string | schedule selection/diagnostic identity | — | yes |
| schedules[].role | no row | must exist in roles | O window role | — | yes for configured role; execution only supports two |
| schedules[].enabled | no row | b | O includes window | — | yes |
| schedules[].weekdays | no row | nonempty ISO integers 1..7 | O date matching, cross-midnight | — | yes |
| schedules[].start | no row | HH:mm, 24:00 allowed; !=end | O local window | — | yes |
| schedules[].end | no row | same | O local window | — | yes |
| schedules[].roleEnabled | optional/null | optional b | overrides role enabled | — | yes |
| schedules[].capacity.minimum | optional/null parent | cap if parent exists | O override/clamp minimum | P | display/validation only |
| schedules[].capacity.target | optional/null parent | cap | O target during window | — | yes planning |
| schedules[].capacity.maximum | optional/null parent | cap | O role ceiling during window | — | yes planning |

Same-role enabled schedule overlaps are rejected including overnight spans; no match inherits base. UI Add interval drafts weekday 1..5, 07:00..23:00, enabled, first existing role, null roleEnabled/capacity. These are editor defaults, not a persisted default schedule. Validation rejects min>target>max conflicts; effective global clipping can lower role minimum below its configured value.

## Operations transition/stability/recovery/health settings

**Every row in this section is currently inert for the advertised runtime behavior.** Runtime consumer=`none`; readers are O validation/effective copy, A snapshot and U UI only. Save still wakes reconciliation. The fact that a field is passed through an object does not count as consumption. L/D=`P` unless stated. Compare executable supervisor constants below.

| O path | Default | Validator | Advertised responsibility / duplicate |
|---|---:|---|---|
| transitions.maximumConcurrentStarts | 1 | i[1,100] | concurrent starts; Core's sequential command dispatch does not enforce in-flight start concurrency |
| transitions.startIntervalMs | 10000 | dur | spacing |
| transitions.maximumConcurrentStops | 1 | i[1,100] | concurrent stops |
| transitions.stopIntervalMs | 10000 | dur | spacing |
| transitions.gracefulStopTimeoutMs | 300000 | dur | safe stop deadline; overlaps P 5000 ms process fallback (D) |
| stability.scaleUpCooldownMs | 60000 | dur | capacity change cooldown |
| stability.scaleDownCooldownMs | 300000 | dur | capacity reduction cooldown |
| stability.minimumBotRuntimeMs | 600000 | dur | minimum uptime |
| stability.minimumBotDowntimeMs | 60000 | dur | minimum downtime |
| recovery.restartOnCrash | true | b | overlaps B unconditional desired-running reconnect (D) |
| recovery.restartOnDisconnect | true | b | same (D) |
| recovery.restartOnUnexpectedStop | true | b | same (D) |
| recovery.maximumRestartAttempts | 5 | i[0,1000] | overlaps B crash count 8 (D) |
| recovery.restartWindowMs | 600000 | dur | overlaps B 300000 (D) |
| recovery.restartDelayMinMs | 5000 | dur; <=max | overlaps B base 1000 (D) |
| recovery.restartDelayMaxMs | 60000 | dur; >=min | overlaps B cap 30000 (D) |
| recovery.replaceUnhealthyAccounts | false | b | no general unhealthy replacement controller |
| recovery.autoReplaceBannedAccounts | false | b | Q consumes C counterpart (D) |
| health.maximumConsecutiveFailures | 3 | i[1,1000] | failure threshold |
| health.maximumCrashesPerWindow | 5 | i[1,1000] | overlaps B crash budget (D) |
| health.crashWindowMs | 600000 | dur | overlaps B crash window (D) |
| health.maximumLoginFailures | 3 | i[1,1000] | login threshold |
| health.maximumRealmEntryFailures | 3 | i[1,1000] | realm threshold |
| health.quarantineUnhealthyAccounts | true | b | no automatic quarantine policy consumer |
| health.quarantineDurationMs | 1800000 | dur | pool cooldown commands are separate (D concept, not same owner) |

## Operations account reserve

| O path | Default | Validator | Runtime consumer / effect | L/D | Functional? |
|---|---:|---|---|---|---|
| reserve.minimumReadyAccounts | 0 | i[0,1000000]; <=target | A.snapshot display | P | no minimum repair threshold |
| reserve.targetReadyAccounts | 0 | i[0,1000000]; >=min | R.planAccountGeneration and A.snapshot | — | yes, inconsistent availability/pending accounting |
| reserve.automaticAccountGeneration | false | b | R generation permission | D | yes ordinary path only |
| reserve.maximumTotalAccounts | 0 | i[0,1000000] | R total+pending cap | D | yes ordinary path only; zero blocks |
| reserve.maximumPendingAccountGeneration | 1 | i[0,1000] | R in-memory count budget | — | yes ordinary path only; zero blocks |

## Related settings outside policy objects

| Setting/source | UI / default / validator | Reader / effect / wakeup | Classification and status |
|---|---|---|---|
| coreBotControl.manualHold | Core release button, lifecycle/database commands; false; bot ID/allowed control fields | R/Q/M ownership exclusion; generation increment and schedule | user operational intent, functional; B/F bypass Core ownership checks |
| tasksData.type/enabled/itemId/buyPricePerOne/sellPricePerOne | Database/task editing; test/1/null prices; SQL task enum/price checks + editor | F loads worker, D configured prices/counts, R writes; database.changed + dataRevision | configured workload, also Core-owned assignment; mixed writer ownership |
| botData.serverId/realm/connectedAccountId/archived | Bot/DB UI; nullable target/account, archived=0; schema/editor + assignment constraints | start eligibility/config preparation; definition sync/events | execution placement + account binding, functional |
| accountsData.banned/disabled/currentBanId | incidents/DB account management; false/false/null; SQL + IncidentStore | X/G/Q/AccountPool safety eligibility; tracked DB revision | account fact/manual exclusion, functional |
| accountPoolState.status/cooldownUntil/failureCount | pool commands/DB editor; available/null/0; enum/nonnegative SQL checks | G/Pool/Q/X eligibility; data revision | durable health/availability facts, not general Operations quarantine implementation |
| autoRestartOnSettingsChange | src/config/botManager.json, false; `===true` constructor | F polls 2 s, schedules restart after 750 ms | infrastructure/execution automation, functional competing loop; no Core policy wake on file edit |
| reconnectBaseDelayMs/reconnectMaxDelayMs/reconnectJitterMs/stableConnectionMs | B constants 1000/30000/500/60000; no UI/store/validator | B retry/stability timers → supervisor events | runtime recovery policy hard-coded, duplicate O intent |
| crashWindowMs/maxCrashesInWindow | B constants 300000/8; none | B crash protection | hard-coded authority, not O health settings |
| heartbeatCheckIntervalMs/heartbeatTimeoutMs | B constants 5000/20000; worker interval 5000 | B kill; worker timestamps | infrastructure liveness, functional |
| P stop timeout / worker exit delay | constants 5000/3000 | process cleanup | execution deadlines, functional; no role cycle guarantee |
| AfkRecovery transitionTimeoutMs | constructor default 30000 | execution phase recovery/fatal signal | runtime tuning, functional; no global target |
| RealmReadyGate default base/jitter | 15000/3000; local integer bounds | readiness; role timing can override | runtime/role tuning, distinct from capacity |
| resellerSettings → profileSettings → botSettings | Database editor / typed parseSettingValue; data-driven names/defaults, not fixed Core fields | G resolved settings → F/P → WorkerSettingsStore → reseller execution; DB/config events | role execution config, retain precedence; do not import all into Core policy |
| realmStartDelayMs in reseller settings | fallback 15000 | ResellerTask and AfkRecovery readiness timing | execution tuning, differs from generic ready event delay |
| Telegram config/env | ConfigManager.telegramConfig; schema/protocol checks; secrets excluded | TelegramManager request timeout/auth/bind limits/reconnect; worker/account facts | infrastructure/protocol, not capacity policy; retain separate |
| DB/logger/eventBus/captcha config | ConfigManager accessors | infrastructure initialization/logging/validation | retain separate; no target count ownership |
| core.json / accountManager.json | empty files; no readers found | none | dead candidate after dependency audit |
| app.json / minecraft.json | no ConfigManager accessors in current composition | no startup consumer found | legacy/unknown deployment use; do not delete on this audit |

The role-settings domain supports arbitrary stored names, so enumerating database contents would confuse deployment-specific values with the Core schema. Core/Operations fields above are exhaustive by their source descriptors. ResellerTask's directly observed loop tuning includes idleLoopDelayMs=250, waitingForRealmDelayMs=500, cycleBusyDelayMs=50, cycleErrorRetryDelayMs=1000, cycleSuccessDelayMs=50, cycleRetryDelayMs=250, capacityProbeMinDelayMs=50, capacityProbeMaxDelayMs=250, storageFullRetryDelayMs=100, cycleFallbackDelayMs=300, waitingForSaleLoopDelayMs=1000. These are execution sleeps, not reconciliation timers or market-analysis frequency.

## Consumer verification rule

An unused-field finding was checked by repository-wide JavaScript references, then by reading O, A, R, Q and B. No dynamic generic Operations dispatcher consumes transition/stability/recovery/health objects. A future implementation must add a consumer test before the UI can claim these controls work. Policy schema/validation/UI tests alone are insufficient.
