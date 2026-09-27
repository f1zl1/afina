# Core v2 Phase 8 — Migration completion

Implemented and verified 2026-09-26. Schema remains **v12**. Autonomous trading and Trading Intelligence remain disabled.

## Changed files

- `src/main.js`: finish Core startup recovery before exposing Web commands.
- `src/core/economicCoordinator.js`: residual review admission gate, operator evidence/readiness, recorded review, and authoritative absence requirement for uncertain closure. Review never rewrites economic evidence or worker safety.
- `src/core/coreCapabilities.js`: explicit unsupported configured trading/relisting and partial external reconciliation.
- `src/minecraftBot/taskRunner/botTaskRunner.js` and `modes/reseller/resellerTask.js`: production Reseller is always manual; removed the configured-cycle switch and loop.
- Reseller `economicExecution.js`, `resellerInventory.js`, `inventory/inventoryActions.js`, `resellerSeller.js`, `server/resellerServerActions.js`: baseline inventory and last confirmed operation; preserve unrelated items at inventory preparation; recheck held item and attributed quantity immediately before listing; abort unused response listeners.
- `src/events/workerEventNormalizer.js`: allowlisted confirmed-operation evidence.
- `src/minecraftBot/worker/{botWorker,sendChat}.js`: worker-side console guard against auction commands and slash-command interference with unsafe work. Internal navigation retains its existing ownership checks.
- `src/webTerminal/public/js/coreController.js`: Ukrainian evidence, readiness, residual/uncertain review, and separate worker-safety diagnostics, using backend review/admission decisions.
- Removed production `reseller/resellerAuction.js` and `reseller/auction/auctionRelist.js`. Their compatibility copies and the old configured task live only in `tests/helpers/legacy{ConfiguredReseller,ResellerAuction,AuctionRelist}.js`.
- `tests/coreWorkloads.test.js`: existing configured-cycle drain assertions now explicitly use the isolated helper. `tests/economicWorkloads.test.js` reuses `tests/helpers/economicFixture.js`; its existing 46 cases remain. The shared fixture uses the real Core facade and mocked Minecraft transport.
- `tests/migrationCompletion.test.js`: 22 focused cases. `tests/browserSmoke.mjs`: blocked resolution, external review, retained uncertainty and residual-review rendering. This report records the final audit.

## Final ownership audit

| Classification | Production path / finding | Disposition and evidence |
|---|---|---|
| REMOVE | Configured Reseller cycle, automatic relisting and its production factory | Production task has only correlated manual assignment/cancellation listeners. No configuration flag activates a loop. Source import audit excludes the isolated executors. Reconstruction, role/configuration restart and binding all eventually use this same task factory. |
| ISOLATE | Old cycle/relist tests | Explicit `tests/helpers` copies preserve historical boundary tests; no production imports. Pure relist result parser is inert compatibility data, with no production relist executor. |
| RETAIN | Buyer, seller, inventory, server-action mechanics | EconomicExecution is their production consumer. No second scheduler or inventory subsystem added. Old cleanup methods have no caller in manual execution. |
| RETAIN | Lifecycle | Operator command → Core CommandService → LifecycleArbiter → ActionLedger/resource reservation → guarded BotManager/BotProcess mechanics. Observation and incarnation evidence determine completion. Manual force remains an explicit separate command; normal STOP does not infer safety from timeout. |
| ISOLATE | BotManager branches without an installed lifecycle arbiter | Required by standalone compatibility fixtures. Production Core installs the arbiter during construction, before startup recovery or external command admission. Installed-arbiter branches return before legacy restart/reconnect execution. Real Core/BotManager composition test rejects an unowned start. |
| RETAIN | Configuration/binding/crash/heartbeat requests | Configuration's coalescing timer calls `restartBot`; production delegates to `LifecycleArbiter.request`, with current incarnation. Binding continuation uses the reserved action. These are inputs to ownership, not independent restart permissions. Pending configuration snapshots remain configuration data. |
| RETAIN | Ban/persistence-failure safety stop; application shutdown | Explicit safety exceptions remain. They inhibit admission and terminate mechanics; they never schedule or replay economic work. Shutdown is bounded and may kill an unsafe worker, retaining unknown economic outcome. |
| RETAIN | Account generation/replacement | Canonical policy and scheduler → shared ActionLedger claims → existing replacement/generation/assignment services. Durable generation results and replacement request receipts retain idempotency. Assignment requires stopped mechanics and valid ownership. |
| RETAIN | Imported legacy pending actions | `ActionCoordinator.importLegacy` converts executor-progress rows into shared ledger ownership. It does not replay an executor. Reconciliation clears obsolete pending pointers and preserves receipts/backoff. |
| RETAIN | Analyst | Existing planner/AnalysisCoordinator → scheduler admission → WorkloadCoordinator → AnalystTask. Restart cancels interrupted sessions, releases reservations and fences late evidence; later work needs fresh admission. |
| RETAIN | Manual economic execution | Authenticated Web operator → InterfaceGateway/Core → EconomicCoordinator PENDING → bounded scheduler selection → durable ADMITTED commit → WorkloadCoordinator → always-manual Reseller → existing mechanics → correlated evidence → economic store → Core snapshot/UI. Stable request identity and active-bot exclusivity remain. |
| RETAIN | Cancellation and reconciliation | Same-incarnation drain, workload generation/lifecycle epoch and sequence fences; terminal uncertainty is never replayed. Operator closure is a recorded acknowledgement, not execution authorization. |
| FIX | Web opened before startup reconciliation completed | `await core.start()` now precedes `webTerminal.init()`. |
| FIX | Missing bot observation could be treated as old executor absence | Closure now requires observed process absence or a different current incarnation. An archived/missing bot cannot supply that evidence. |
| FIX | Unrelated inventory could arrive after preflight | Preparation refuses unrelated held items; queued listing checks target, one-item quantity, hotbar and proven remaining inventory count. Tests inject both unrelated and additional matching items at these boundaries. |
| FIX | Console could issue `/ah` while a workload owned the worker | External auction commands (`ah`, `auction`, `auctions`, `auc`, including namespaced forms) are refused. Slash commands during busy/uncertain/quiescing work are refused at the worker boundary. Ordinary chat remains available. |

No production path found independently schedules configured trading, replays an uncertain workload, or supersedes durable lifecycle/resource ownership. Raw operator interaction is not an economic receipt; arbitrary server-specific command aliases and external clients are outside the managed workload protocol.

## Operator reconciliation and residual inventory

The snapshot/UI shows identity, original terms, original/current incarnation, current drain/status/reason, last operation and confirmed operation, proven bought/listed quantities, baseline inventory, timestamped last inventory evidence, possible unresolved effects, review history and current admission blocker. Listing acknowledgements are not sales, revenue or a current auction snapshot. Old records without evidence timestamps display unknown time.

1. Inspect evidence and the bot's current observation. Do not infer an interrupted transaction's result from a later inventory snapshot.
2. For UNCERTAIN, request normal STOP. If safety refuses it, an operator must make the separate explicit force-stop decision. Verify old-process absence. A missing/archived bot must be made observable again; missing observation alone cannot unlock review.
3. Check actual inventory and auction listings externally, using server-permitted manual actions. No automatic selling, dropping, relisting or matching of residual stock is provided.
4. Record a 10–500 character note. Uncertain closure becomes CANCELLED / `OPERATOR_ACKNOWLEDGED_UNKNOWN`; historical quantities and UNCERTAIN certainty remain. Proven partial records keep their original status/result and progress, adding only review metadata. Evidence timestamps are unchanged.
5. Review current backend readiness. Closing a record does **not** clear sticky worker uncertainty. After external verification, use a new worker incarnation, verify fresh observation/realm readiness, and explicitly release manual hold if appropriate. A new workload still performs inventory preflight. Do not reuse an old request ID to request a new trade.

Unreviewed proven residuals (including cancellation or listing-capacity failure) block new work on that bot with `RESIDUAL_INVENTORY_REVIEW_REQUIRED`. Preexisting target stock and an occupied sell slot also require review. Attributed remaining quantity is displayed only when known execution counts agree with its last inventory evidence; mismatches remain unattributed. Review does not dispose of inventory: remaining target stock causes the next execution to refuse before purchase/listing. Tests cover 4/10 bought, 2/4 listed, cancellation after purchase, unrelated baseline stock, and late inventory arrivals.

## Startup and shutdown

- Database migration precedes configuration/Core construction. BotManager loads definitions, not an autonomous Reseller loop. Core installs lifecycle ownership before starting reconciliation; Web and Telegram entry points follow Core startup.
- Canonical policy, manual holds, lifecycle intent, retry/backoff and generation/replacement receipts stay durable. Existing ledger actions reconcile against authoritative observation and reservations. Configuration changes are re-read; binding requests remain ledger/lifecycle inputs.
- Abrupt restart preserves PENDING economic requests for fresh admission. ADMITTED/RUNNING/DRAINING become UNCERTAIN, retaining progress and requesting cancellation of any matching surviving executor. Existing UNCERTAIN remains blocked. No dispatched request is blindly repeated.
- Interrupted Analyst sessions are cancelled rather than continued under stale identity. Late worker evidence is fenced by existing incarnation/generation checks.
- Graceful application shutdown cancels pending economic work without execution and requests drain for admitted work. Core then closes admission/listeners; BotManager performs bounded shutdown. A result arriving after Core closes its listener can remain DRAINING durably; restart conservatively converts it to UNCERTAIN. This may require review even if the external operation finished successfully.
- Phase 7 regression cases cover application shutdown during drain, stale incarnation, STOP/REPLACE and configuration/binding/recovery interaction. Phase 8 adds all interrupted statuses, pending restart, real composition and gateway-driven successful/partial/cancelled/uncertain outcomes.

## Schema and deployment

No schema increment or configuration rewrite. New evidence/review fields fit the existing v12 economic JSON document; existing records remain readable. Temporary v11 fixtures are constructed from a fresh database with v12 additions removed, never from the configured production database.

Verified SQLite backup before upgrade, `BEGIN IMMEDIATE`/rollback behavior, v12 migration receipt/version, FK/integrity checks, retained account/task/action rows, durable economic history on reopen, and repair/retry after an intentionally failed migration. The backup is a complete SQLite database, not selected-table export. Current-version reopen does not create another migration backup. Existing legacy import tests also remain green. No configured production database was opened or modified by these checks; `migration:check` was not used against its default live path.

Deployment checklist:

1. Stop the existing application and verify its workers have exited. Record unresolved operations; never assume process exit proves transaction outcome.
2. Verify the resolved database location and working directory. Default `src/config/dataBaseManager.json` uses relative `src/data/afina.db`; retain the configured legacy paths when migrating an old split database.
3. Take a recoverable offline/SQLite-consistent backup of the database (including any outstanding WAL state), configuration and previous application version. Keep all legacy databases if applicable. Verify the backup opens and passes integrity checks.
4. Install this version and dependencies. Run upgrade on a temporary copy first. Migration creates its own pre-upgrade backup; that does not replace the deployment backup. Do not run old and new applications concurrently against one database.
5. Inspect `PRAGMA user_version` (=12), migration receipt, `PRAGMA foreign_key_check` (empty), `PRAGMA integrity_check` (`ok`), and retained accounts/tasks/actions/economic history. If upgrade fails, keep the application stopped and investigate the transaction failure.
6. Start the application. Inspect canonical policy diagnostics, startup hold, Core observation freshness, incarnation, lifecycle ownership/reservations and outstanding uncertainty. Confirm no unexpected worker start or transaction replay.
7. Verify Analyst with an allowed small analysis session and fresh correlated results. Verify a small explicitly submitted manual Reseller workload on an eligible bot with empty target inventory and clear sell slot.
8. Verify automatic trading, configured-cycle execution and automatic relisting remain disabled. Verify cancellation/drain and operator review in the deployment environment before wider use.
9. Rollback: stop this version and every worker; restore the complete pre-upgrade database/configuration and matching previous binary. Never downgrade schema in place. Preserve the newer database separately for evidence and reconcile post-backup external transactions before any new work; restoring an older database cannot undo Minecraft effects.

Steps involving a deployed Minecraft server are an operator checklist, **not claimed live verification**.

## Capability truth

| Feature | Status |
|---|---|
| Bounded operator-submitted economic execution | SUPPORTED |
| Analyst execution and shared workload admission | SUPPORTED |
| Autonomous economic execution / configured trading / automatic relisting | UNSUPPORTED |
| Economic reconciliation | PARTIAL: external verification and recorded acknowledgement; no inferred settlement |
| Recovery | PARTIAL: durable policy/backoff and Analyst recovery; autonomous Reseller recovery remains blocked |
| Graceful STOP | PARTIAL: proven drain required; unknown outcomes can refuse normal stop |
| Automatic health/quarantine | UNSUPPORTED |

The existing API spelling of PARTIAL is `PARTIALLY_SUPPORTED`. Legacy settings remain compatible inputs/metadata; their presence never enables an unsupported executor.

## Exact verification

All counts below have **0 failures, 0 cancelled, 0 skipped**.

| Run | Passed | Duration |
|---|---:|---:|
| Final focused `migrationCompletion.test.js` | 22 | 2268.5965 ms |
| Final economic tests: Phase 7 + Phase 8 | 68 | 6357.9103 ms |
| Relevant regression set¹ | 258 | 29045.1357 ms |
| Console/runtime/interface focused set² | 94 | 3588.4312 ms |
| Final `npm test` | **481** | **41972.7519 ms** |
| `npm run test:ui` | 1 browser scenario | 4.4235 s wall time |
| Syntax | 173 files | 0 failures |

¹ `economicWorkloads`, `coreWorkloads`, `coreLifecycle`, `coreActions`, `coreScheduling`, `coreObservation`, `corePolicyAuthority`, `operationsAccountGeneration`, `botConfiguration`, `marketIntelligence`.

² Phase 8 (then 21 cases), `runtimeReliability`, `databaseInterface`; the additional matching-inventory case is included in the final 22/68/481 runs. Temporary migration verification is included in focused Phase 8 and Phase 7 suites, with older upgrade/import paths also covered by the full suite.

The first full run passed 480 tests before the final matching-inventory guard/test; the necessary repeat above validates the final source. The syntax harness's initial nested-process launch was blocked by the sandbox; direct PowerShell-driven `node --check` passed all 173 files, and the three subsequently changed files were rechecked. Browser smoke used real frontend assets with a mock API and isolated Chrome profile: blocked review, resolution history, residual UI, existing Analyst/market views and no JS exceptions. Gateway integration uses real Core, scheduler, workload coordinator and trading mechanics with mocked Minecraft transport and temporary SQLite; browser and transport fixtures are separate, not a live-server end-to-end claim.

## Verdict and boundary

**Core v2 migration is complete for the repository's managed production paths.** The source audit and tests verify one canonical policy, authoritative observation, shared durable lifecycle/resource ownership, bounded scheduler admission, manual-only economic execution, correlated evidence, and no replay of unknown transactions. Compatibility execution is explicitly isolated. Concrete startup, inventory, console-interference and reconciliation defects found in the audit are fixed.

Remaining limits are deliberate: external settlement/inventory verification, no live-server validation, conservative shutdown uncertainty, observation required for closure, no automatic residual processing, and no protection against arbitrary server-specific aliases or external actors changing the game state. Inventory evidence is quantity-based; it is not immutable item identity or proof of a later sale. Deployment backup/recovery must account for external effects independently of database rollback.

The next milestone is **Trading Intelligence**, under a separate task. This phase does not implement it, enable autonomous trading, or introduce another Core architecture layer.
