# Autonomous Trading Execution v1

## Execution path

`MarketModel → existing TradingPlanner → current persisted TradingPlan → TradingExecutionCoordinator → EconomicCoordinator → CycleScheduler → WorkloadCoordinator → ResellerTask → EconomicExecution → existing buyer/seller`.

TradingExecutionCoordinator only admits recommendations. It has no scanner, lifecycle, allocator, process or transaction mechanics. Core invokes it within the existing scheduler's item window, bounded by the cycle action limit; blocked diagnostics are capped at 100 per pass. Actual assignments compete with Analyst and operational work in the existing scheduler. Snapshot queries expose status but never submit work.

TradingPlanner pricing, quantity, fingerprints and history remain unchanged. The public Core snapshot now overlays execution permission/status; the planner itself remains recommendation-only. No dynamic pricing, relisting or configured Reseller loop is restored.

## Canonical policy and risk

The existing Operations Policy stores and edits:

| Field | Default | Bounds / effect |
|---|---:|---|
| `autonomousTradingEnabled` | **false** | Explicit permission for real autonomous purchases/listings |
| `autonomousTradingMaxPurchaseValue` | 100,000 | Positive integer, at most the existing 1,000,000,000 workload commitment limit |
| `autonomousTradingMaxConcurrentWorkloads` | 1 | Integer 1–100; counts PENDING, ADMITTED, RUNNING, DRAINING and UNCERTAIN autonomous records |

There is a fixed maximum of **one active autonomous workload per item**, across all markets/bots. Manual active/pending work also blocks autonomous admission for that item. Manual dispatch waits behind an already admitted/running/draining/uncertain autonomous job for that item. Missing or invalid durable risk limits fail closed.

Admission additionally requires Core automation active, no maintenance/startup hold, enabled Reseller role with positive effective target, current BUY_RESELL identity, unexpired acceptable market evidence, enabled item, nonzero item allocation, current max-buy/min-sell constraints, unchanged plan terms, and ready existing Reseller capacity in the plan's exact server/realm. Existing workload quantity/price/commitment bounds apply. Terms are preserved, never reduced or repriced to fit risk limits.

Creation and dispatch both revalidate current plans and policy. Market or policy invalidation can replace the current plan, producing `TRADING_PLAN_SUPERSEDED`; invalid pending requests are cancelled before worker assignment. A temporarily unavailable opportunity remains blocked without creating a workload. Losing capacity after creation may cancel the pending request conservatively. Turning the switch/Core automation off, maintenance or loss of effective Reseller capacity requests the existing drain protocol for admitted work; in-flight operations are not assumed undone. Lowered numeric exposure limits apply to admission, not retroactive rewriting of executing terms.

No plan creates bots or alters desired allocation. Existing configured desired-capacity policy may independently request Reseller assignment/recovery when its permissions allow; shared lifecycle, action ledger, proxy allocation, manual ownership and worker readiness still govern it.

## Identity, persistence and uncertainty

Schema **v15** adds two indexes to the existing economic table: unique `sourcePlanId`, and unique active autonomous `itemId`. It migrates the canonical execution switch to **false** and installs conservative risk defaults, using existing backup, transaction, receipt and integrity conventions. No parallel execution ledger or new workload table is added.

Autonomous workloads retain `source:AUTONOMOUS_TRADING`, `sourcePlanId`, `sourceTimestamp`, `sourceMarketRevision`, `serverId`, `realm`, and deterministic `requestId = trading_<planId>`. These survive plan-history pruning. EconomicStore provides the durable `planId → workloadId → state/result` lookup. Repeated evaluation, event delivery and restart cannot create another request for the same identity. Database uniqueness complements existing request idempotency and commit-before-IPC dispatch.

COMPLETED, FAILED and CANCELLED consume the identity permanently. Another autonomous request needs a new valid plan **and a strictly newer source timestamp in that market**. Policy-only plan changes cannot reuse old purchase evidence. This rule also conservatively consumes cancelled-before-dispatch evidence; the same plan is never retried.

Any UNCERTAIN economic record for the item, including manual work on another bot/realm, blocks autonomous admission. Unreviewed residual inventory also blocks it. Existing operator resolution/review remains the only reconciliation path. Review preserves historical uncertainty and cannot replay the original identity; current worker safety and inventory preflight still apply. Restart converts admitted/running/draining work to UNCERTAIN, never replays it, and revalidates undispatched pending work.

## Manual separation and UI

Manual submission remains `core.economic.submit`, requires the trusted Web actor and explicitly supplied terms, and is independent of the autonomous switch. New manual records carry `source:MANUAL`; old records read as MANUAL. Autonomous submission is a separate internal method requiring the installed coordinator object, not a user-supplied actor/source string. Both enter the same private EconomicCoordinator creation path and dispatch protocol. Autonomous actors cannot use operator-only submit/resolve APIs or inject source metadata through the manual payload.

The existing `manual_economic` workload type/capability name is retained as transport compatibility for both sources. Durable ADMITTED identity authorizes IPC; the worker reports owner `core` for autonomous work and `manual` for operator work. Incarnation, generation, lifecycle epoch, deduplication, drain and economic evidence checks remain unchanged.

Operations Policy contains the switch and risk controls, with an explicit real-purchase/listing warning. Trading Intelligence displays Ukrainian enabled/disabled status, mode, current blockers and per-plan execution status, bot and workload ID. Economic history distinguishes MANUAL/AUTONOMOUS_TRADING. A completed workload means bought and listed, **not sold or profitable**.

## Guard and production audit

| Production path | Result |
|---|---|
| TradingExecutionCoordinator | Sole autonomous submit caller; policy-aware `TRADING_EXECUTION_DISABLED` only while switch is false |
| CommandService | Existing Web manual submission; no public autonomous command or actor impersonation |
| CoreReconciler / LifecycleArbiter | Former unconditional Reseller blockers now depend on the canonical switch; all other lifecycle permissions remain |
| Core capabilities / compatibility alias | Autonomous implementation is supported, execution blocker reflects policy; enabled capabilities do not emit the disabled code |
| TradingPlanner | No execution permission guard; Core supplies public permission metadata |
| WorkloadCoordinator | Unsupported types return `UNSUPPORTED_WORKLOAD_TYPE`; economic assignment still requires durable ADMITTED identity |
| WorkerWorkload | Rejects unsupported Reseller work with `ECONOMIC_ADMISSION_REQUIRED`; admitted economic work accepts manual/Core ownership |
| UI | Disabled-code labels only render backend diagnostics; no independent permission logic |
| ResellerTask / EconomicExecution | Single correlated assignment path and existing buyer/seller mechanics; no loop/relisting |
| BotManager/start/restart | Existing lifecycle consumers only; neither planner nor trading admission calls them |

Search evidence is in `artifacts/autonomous-production-audit.txt`. There is one autonomous plan-to-economic path, no MarketModel → buyer/seller path and no TradingPlanner → BotManager path. Historical cancelled-workload reasons remain historical facts when the switch is later enabled.

## Verification

Temporary databases, mocked Minecraft transport and isolated Chrome only. Production configuration/database were not opened or enabled. **No live economic or profitability validation.**

| Check | Pass | Fail / cancel / skip |
|---|---:|---|
| New autonomous trading tests | 47 | 0 / 0 / 0 |
| Trading Intelligence, Economic, Market/Analyst, scheduler/workloads, lifecycle/proxy, policy/UI, migration/storage regressions | 321 | 0 / 0 / 0 |
| Browser smoke including switch save, execution/uncertainty, manual UI and responsive layout | 1 scenario | 0 / 0 / 0 |
| Syntax source/tests/scripts | 182 files | 0 |
| One final `npm test` (101,230.9791 ms) | 614 | 0 / 0 / 0 |

Logs: `artifacts/autonomous-focused-final.log`, `autonomous-regressions.log`, `autonomous-browser.log`, `autonomous-full-suite.log`. Development corrected legacy capability assertions and a browser test's duplicate top-level variable declaration. Chrome required the existing isolated smoke command outside the sandbox.

## Limits

Observed offers may disappear; worker purchase/inventory checks remain authoritative. Limits bound each request and simultaneous workloads, not portfolio inventory, unsettled listings, rolling spend or losses. Completed listings are not sales/settlement evidence. No balance reservation, fee inference, portfolio optimization, automatic residual disposal, repricing or relisting was added. One application/Core instance remains the supported lifecycle authority; indexes are not a multi-process scheduling design. Historical execution identities remain durable, while blocked-plan diagnostics are bounded current state rather than a new durable journal.
