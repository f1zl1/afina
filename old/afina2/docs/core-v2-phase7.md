# Afina Core v2 — Phase 7: Economic Workload Execution

## Delivered path and execution authority

An operator can submit a manual buy-and-list workload from the Ukrainian Core panel:

`Web command → EconomicCoordinator validation/durable request → existing CycleScheduler → WorkloadCoordinator → ResellerTask/WorkerWorkload → existing buyer, seller, inventory and server actions → correlated evidence → durable Core result/UI`.

Production BotTaskRunner now constructs ResellerTask in **manual-only mode**: a ready Reseller waits for a submitted workload instead of starting its old configured trading loop. The old configured-cycle branch remains for direct mechanical compatibility tests; production task construction does not select it. Worker facts explicitly advertise manual-economic support. Older/configured-cycle workers cannot receive manual admission. No Market Intelligence or decision-engine caller submits trades.

The audit found that the existing buyer retries indefinitely and purchases whole lots; the seller prepares/lists **one item**, with server-response parsing. Receipt is supported by inventory increases; listing is supported by a server acknowledgement. Sold quantity, settled balance debits and revenue are not independently proven. These findings define the bounded implementation, rather than introducing a second trader.

## Contract and manual commands

`core.economic.submit` requires a Web operator actor and:

```json
{
  "requestId": "operator-generated-stable-id",
  "botId": null,
  "itemId": 1,
  "maxBuyPricePerItem": 100,
  "targetSellPricePerItem": 150,
  "targetQuantity": 10
}
```

`botId` is optional. Prices are positive safe integers; quantity is 1–64; maximum price is 1,000,000,000 and maximum quoted purchase commitment is 1,000,000,000. At most 100 pending requests are allowed. These are small execution-contract bounds exposed in the backend snapshot, not a new risk-policy subsystem. Existing canonical controller limits govern admission.

The item must exist and supply a valid bounded search query and a matcher the real inventory matcher supports (`minecraftName`, optional numeric `potionId`). Unknown fields, malformed prices/quantities, and unsupported matchers are rejected. The request snapshots the item and explicit operator terms; it does not modify task configuration or derive profitable prices.

Explicit bot selection must be eligible at submission; scheduler selection uses eligible Resellers if omitted. Both paths revalidate readiness, configured role, manual hold/lifecycle owner, pending transitions/configuration, active claims, incarnation, generation, workload safety and manual-economic capability at dispatch. Maintenance blocks admission. Manual execution can operate with autonomous automation disabled; it cannot spawn a worker or bypass manual hold. Start a configured Reseller and release its lifecycle hold before submitting work.

Repeated `requestId` plus identical terms returns the same durable workload; changed terms produce `IDEMPOTENCY_CONFLICT`. Retrying a failed/uncertain request never creates another trade. `core.economic.cancel` requests drain. `core.economic.resolve` records an operator verification note (10–500 characters) only after the old executor is no longer running; it closes an uncertain record without claiming that its unknown economic outcome became known.

Capabilities distinguish supported `manualTradingExecution` from unsupported `autonomousTradingExecution`. Existing autonomous `resellerTrading` and `TRADING_EXECUTION_DISABLED` guards remain enforced. Internal/system actors cannot use manual submission.

## States, evidence and bounded mechanics

Durable states are `PENDING`, `ADMITTED`, `RUNNING`, `DRAINING`, `COMPLETED`, `FAILED`, `CANCELLED`, `UNCERTAIN`. Pending/admitted map to common workload STARTING intent; accepted worker execution uses the Phase 6 RUNNING/draining/terminal states. IPC send success is not execution success.

- A fresh workload refuses pre-existing matching inventory and an occupied sell slot, avoiding attribution or disposal of operator property.
- Existing buyer/scanner code performs one bounded search attempt per required purchase, rechecks price and lot count, and excludes lots larger than the remaining quantity. No blind retry/refresh loop runs for manual economic work.
- Exact inventory receipt confirms bought quantity. Unexpected receipt size, transport ambiguity or missing verification becomes uncertain.
- Existing inventory preparation and seller list one item at the explicit sell price. Listing acknowledgement increases listed quantity; inventory must subsequently match the expected remainder before another operation.
- Existing relist mechanics are not invoked for manual jobs: relisting unrelated prior listings cannot be attributed safely to this request. Existing relist uncertainty still blocks admission/normal safe stop.

Results persist monotonically increasing `boughtQuantity`, `listedQuantity`, quoted `purchaseValue`, remaining inventory when observable, operation, sequence and reason. **purchaseValue is the sum of quoted prices of lots whose receipt was verified, not a reconciled account debit.** `spentAmount`, `soldQuantity` and `receivedAmount` remain null. UI explicitly labels these unknowns. `COMPLETED` means the requested quantity was bought and listed, not sold or profitable. FAILED/CANCELLED can contain proven partial progress, such as 4/10 purchased or 2/4 listed. UNCERTAIN retains the proven lower bounds and identifies unresolved effects.

Every result is correlated with workload ID, admitted incarnation, lifecycle epoch, role generation and increasing sequence. Different workload/incarnation/generation/epoch payloads and regressing/out-of-bound counters are rejected. Drain/terminal evidence belonging to the same admitted execution can preserve partial results after lifecycle takeover; it cannot authorize more execution, change lifecycle intent or mutate another workload/incarnation.

## Persistence, reconciliation and lifecycle

Schema **v12** adds only `economicWorkloads`, a durable request/result document plus indexed identity/status. A unique partial index permits one admitted/running/draining/uncertain workload per bot. This is workload exclusivity, not a second account/bot lifecycle reservation system. Foreign keys preserve referenced bot/item identity; archive entities rather than deleting financial history. No scheduler cursor or UI cache is persisted. The Core connection uses SQLite synchronous FULL so admission commits are synchronized before IPC.

The normal migration framework backs up v11 before a transactional upgrade, checks foreign keys/integrity and records v12. No production database was migrated during development or testing.

Admission is committed **before** assignment IPC. Unconfirmed dispatch, process/incarnation loss, role replacement or unconfirmed drain become UNCERTAIN. On Core restart, PENDING requests remain eligible for revalidation because they were never dispatched; ADMITTED/RUNNING/DRAINING become UNCERTAIN and any surviving matching executor receives cancellation. They are never replayed. Clean application shutdown cancels pending requests and drains admitted ones; interrupted drains remain reconcilable as uncertain on restart.

Cancellation stops new economic operations but waits for an in-flight purchase/listing response and inventory evidence. STOP uses the same Phase 5/6 workload drain. Failed or uncertain cleanup refuses normal safe acknowledgement. A safe checkpoint still does not complete STOP: authoritative process absence remains required. REPLACE, manual restart/hold, configuration/binding/recovery changes fence admission and request drain. Existing LifecycleArbiter permissions, backoff, action claims, manual force and bounded shutdown remain authoritative. Economic business failures do not request process restart.

The existing scheduler selects Analyst, economic and operational candidates together, with its aging, rotating windows, action/candidate bounds, cooperative checkpoints and coalescing. Economic admission never reserves a lifecycle ActionLedger action. There is no new Core execution/polling loop.

## UI and changed paths

The Ukrainian Core form selects item, optional ready bot, buy/sell prices and quantity. It displays backend validation errors, stable workload identity, progress/partial results, cancellation/drain, uncertainty and explicit operator resolution. Refresh does not reconstruct transaction truth. There is no profitability or Trading Intelligence UI.

New source: `src/workloads/economicContract.js`, `src/core/economicStore.js`, `src/core/economicCoordinator.js`, `src/minecraftBot/taskRunner/modes/reseller/economicExecution.js`.

Integration changes: Core scheduling, commands/capabilities, Phase 6 workload contract/coordinator, task runner/Reseller adapter, buyer/scanner/seller/server-action hooks, worker event map/normalizer, schema/migration and Core frontend. Tests add `economicWorkloads.test.js`, browser economic scenarios and current-version expectations in existing migration/schema tests. The v10 fixture removes later schema receipts before upgrade; existing assertions remain intact.

## Final execution-authority audit

| Path | Authority and boundary |
|---|---|
| `CommandService → economic.submit` | Sole production creation call; requires explicit Web operator terms |
| Market/planner/reconciler | No economic submit caller; autonomous trading stays blocked |
| EconomicCoordinator → CycleScheduler | Durable pending work enters existing fair/bounded selection |
| WorkloadCoordinator → economic IPC | Rechecks ownership/capability; sends the durable admitted document |
| Production ResellerTask | Manual-only listener, worker identity/deduplication and one active job |
| EconomicExecution | Bounded composition of existing mechanics; no process/account executor |
| Buyer/seller/inventory/server actions | Existing transaction paths with bounded-lot and evidence hooks |
| Configured-cycle/relist code | Retained mechanical compatibility branch; not selected by production task runner/manual API |
| Results/cancellation/restart | Durable admitted identity and evidence; unknown effects never authorize replay |
| LifecycleArbiter/BotManager | Existing lifecycle authority/mechanics, unchanged ownership |

Targeted searches covered reseller/buy/sell/relist/price/inventory/transaction/workload/trade/auction and all new submission/admission hooks. No second production economic scheduling or lifecycle authority was introduced.

## Verification

All Minecraft execution used local mocked transport, including the real buyer, inventory splitter, seller, task runner, command service and Core result path. All databases and browser profiles were temporary.

| Final verification | Pass / fail / cancelled / skipped | Duration |
|---|---|---:|
| Phase 7 focused (`economicWorkloads.test.js`) | 46 / 0 / 0 / 0 | 5115.7791 ms |
| Relevant Phase 3–6 + market/runtime/storage subset | 275 / 0 / 0 / 0 | 24872.217 ms |
| `npm test` — one final full-suite run | 459 / 0 / 0 / 0 | 40001.4064 ms |
| `npm run test:ui` | 1 smoke / 0 / 0 / 0 | 4.2046 s shell elapsed |
| Syntax checks, all source/tests/scripts | 170 files / 0 / not applicable / 0 | 7.3419 s shell elapsed |

The regression subset contains `coreActions`, `coreObservation`, `coreScheduling`, `coreLifecycle`, `coreWorkloads`, `marketIntelligence`, `runtimeReliability`, `storageMigration`. New focused tests include v11→v12 backup/integrity/idempotent reopen and a failed-upgrade rollback; existing storage tests retain earlier migrations. No migration preview against the configured/live database was needed.

Focused coverage includes command-to-real-mechanics completion, invalid contracts, selection/hold/capability rejection, actor/idempotency fencing, scheduler limits and mixed Analyst fairness, partial purchases/listings, inventory isolation, cancellation before/during purchase/listing, uncertain buy/sell/relist safety, interrupted admission/no replay, stale correlations/generation, lifecycle interactions, STOP drain, shutdown, operator resolution and migration persistence. Existing regressions retain STOP absence, action/account exclusivity, generation receipts, replacement idempotency and coalescing. Browser smoke covers submission, validation failure, progress, cancel, uncertainty and prior responsive/policy/market behavior.

Development corrections included a downgraded migration fixture retaining a later receipt and a browser test refresh resetting an unrelated unsaved policy fixture. Final results above supersede those development attempts.

## Limitations and Phase 8 boundary

- No autonomous selection of items/prices/quantity, Trading Intelligence or automatic relisting. Production configured Resellers now wait for manual jobs.
- Whole-lot buying can end partially when no lot fits remaining quantity/price. Work ends instead of retrying indefinitely. Listing-capacity rejection preserves acquired inventory; it does not sell/relist older inventory to make room.
- Inventory and listing acknowledgements do not prove sales, cash settlement or profitability. Live server protocol/economic correctness was not tested.
- Unknown execution is not automatically resumed, even if a later inventory snapshot looks plausible. Operator verification/closure preserves the uncertainty label and never replays the old identity. A separate request is a new deliberate instruction; residual target inventory must first be handled by the operator.
- Requests/history are retained for idempotency. UI shows the most recent 100 records; historical retention/archival is not a new subsystem in this phase.
- Synchronous database/planning work remains non-preemptible. The existing scheduler supplies cooperative rather than hard real-time deadlines.

Phase 8 should complete migration by explicitly deciding legacy configured-cycle retirement and the operator workflow for reconciling residual/uncertain inventory, then validating deployment/upgrade behavior. It must preserve this manual execution boundary and must not implicitly enable Trading Intelligence. **Phase 8 was not started.**
