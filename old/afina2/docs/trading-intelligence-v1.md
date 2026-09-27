# Trading Intelligence v1

## Architecture and execution boundary

`MarketStore / MarketModel → TradingPlanner → TradingPlan → Core snapshot / Web`.
The planner has no bot, worker, scheduler-capacity or EconomicCoordinator dependency. It reads the existing classified market model; no scanner, forecasting, repricing or transaction executor was added.

Core evaluates recommendations during its existing planning stage and before returning a snapshot. Market updates, policy/item changes and one nearest-expiration wakeup feed the existing coalescing Core scheduler. Stable per-market evidence/policy fingerprints reuse persisted decisions, including across restart. Clock-only confidence changes and unrelated market revisions do not generate history. Expiration invalidates a recommendation; unchanged expired HOLD does not repeat indefinitely. Shutdown clears the wakeup.

`SHADOW`, `executionEnabled:false`, and `TRADING_EXECUTION_DISABLED` remain explicit. Recommendations never submit workloads. Real execution still requires the operator's existing manual form and follows EconomicCoordinator → CycleScheduler → WorkloadCoordinator → manual ResellerTask → EconomicExecution. All lifecycle, proxy and worker-safety admission remains authoritative.

## Plan and implemented rules

Each plan contains `planId`, `itemId`, `serverId`, `realm`, `decision` (`BUY_RESELL` or `HOLD`), `maxBuyPricePerItem`, `targetSellPricePerItem`, `targetQuantity`, `expectedProfitPerItem`, `expectedMargin`, `confidence`, `marketModelRevision`, `sourceTimestamp`, ordered machine-readable `reasons`, `createdAt`, and `expiresAt`. Market identity is retained: one item's different realms are never combined. Confidence is the value at evaluation, not a claim of live certainty.

- Require a supported Economic Workload item matcher/query, fresh evidence, confidence ≥50%, independent supply and at least two sellers. The 50% threshold matches the existing Analyst's low-confidence threshold. Aging, stale, reanalysis-required, missing, future-dated or insufficient evidence produces HOLD.
- Sell target: floor of independent retail median, backed by at least three retail lots. Market Intelligence's own-listing and high-outlier exclusions apply. If this price is below `minSellPrice`, HOLD; do not raise the target above market evidence to satisfy a floor.
- Buy ceiling: rounded-up observed unit price of the cheapest fitting existing wholesale opportunity, still ≤75% of retail reference, below sell target, and ≤`maxBuyPrice`. No configured minimum profit/margin or transaction-fee model was found in the production contracts; none was invented. Profit is sell minus buy, and margin is profit divided by buy. Non-positive profit is rejected.
- Quantity: one complete observed opportunity lot, never a partial lot, capped by independent supply, the existing 64-item workload maximum and 1,000,000,000 purchase commitment. Both prices must be positive safe integers ≤1,000,000,000. A lot that cannot fit produces HOLD or allows the next fitting candidate. Bot counts are not multiplied into inventory permission.
- Expiration: no later than `lastObservedAt + marketFreshMs`, and earlier if modeled confidence would fall below 50%. Expired evidence cannot yield BUY_RESELL. HOLD has quantity zero and null economic terms; reasons explain the blocker.

Existing equivalent codes are reused: `DATA_STALE`, `LOW_CONFIDENCE`, `ITEM_DISABLED`, `ITEM_MAX_BOTS_LIMIT`, `MAX_BUY_PRICE`, `MIN_SELL_PRICE`, `INVALID_ITEM`, `PRICES_UNAVAILABLE`, `PURCHASE_VALUE_LIMIT`. Additional recommendation codes are `MARKET_UNAVAILABLE`, `INSUFFICIENT_SUPPLY`, `NO_PROFITABLE_SPREAD`, and `PROFITABLE_SPREAD`.

## Configuration and production-path audit

| Concern | Canonical owner / meaning |
|---|---|
| Item consideration | `coreItemOverrides.disabled`; items have no separate enabled column. Enabled consideration does not imply buying. |
| Task enabled | `tasksData.enabled` enables that bot's configured role; it is not item-wide trading permission. Existing field semantics are preserved. |
| Desired Resellers | CoreDecisionEngine, canonical `operations.roles.reseller.target`, per-item minimum/forced/maximum and `maxResellersPerItem`; independent of TradingPlan. |
| `maxBots=0` | Zero allowed Reseller allocation, never unlimited. Planner returns HOLD with `ITEM_MAX_BOTS_LIMIT`; it does not falsely report `ITEM_DISABLED`. Null inherits the global per-item maximum. |
| Disabled/zero allocation diagnostics | Effective requested/minimum allocation is zero. Suppressed forced/minimum requests are not presented as active `USER_FORCED_BOTS`/`USER_MIN_BOTS`; stored operator intent is retained. `TARGET_RESELLER_COUNT` remains the global target, not an item request. |
| Legacy configured buy/sell prices | Database/task configuration → CoreDecisionEngine's configured allocation quote; CoreReconciler and AccountReplacements retain their checks. These are not silently reinterpreted as recommendation bounds. Explicit override max-buy/min-sell are the planner's economic constraints. |
| Recommendation prices | TradingPlanner only; never writes task prices, allocation proposals or automatic-pricing provider state. |
| Executed prices / quantity | Explicit Web operator request → EconomicCoordinator → economic contract → EconomicExecution → existing buyer/seller mechanics. |
| Workload creation | CommandService's `core.economic.submit` remains the sole production caller of EconomicCoordinator.submit; trusted Web actor validation remains. |
| Autonomous permission | CoreReconciler, LifecycleArbiter and WorkloadCoordinator retain `TRADING_EXECUTION_DISABLED`. Manual Reseller waits for correlated assignments; no configured trade loop or relisting is restored. |

Searches covered desired counts, enabled/maxBots/forcedBots, configured and executed buy/sell prices, economic submission and execution guards. There is no market → direct buy/sell path. No live configuration or production database was changed for the audit.

## Persistence and Web

Schema **v14** adds `tradingPlans`: sequence, item/market scope, fingerprint and small JSON decision document, with a scope/sequence index. Existing migration backup, transaction, rollback, integrity and migration-receipt conventions apply. Retention is 20 decisions per item/market; snapshots expose current plans plus the most recent 100 historical decisions. No duplicated market snapshots, credentials or scheduler ownership are persisted. Historical scopes remain retained if an item is removed; current plans only include current configured items.

The existing Core page contains a compact Trading Intelligence table with item/market, Ukrainian BUY/HOLD labels, prices, profit, margin, quantity, confidence, source time, expiry and reason codes. It explicitly displays **Автономне виконання вимкнено**, SHADOW and the execution blocker. There is no trading-enable or automatic-submit button. Capabilities distinguish supported recommendations from unsupported autonomous execution. Browser smoke covers both decisions, live refresh and responsive layout.

## Verification

All execution evidence comes from temporary databases, mocked Minecraft transport and isolated Chrome with a mock API. No live profitability validation was performed.

| Check | Passed | Failed / cancelled / skipped |
|---|---:|---|
| New Trading Intelligence tests (in final focused run) | 30 | 0 / 0 / 0 |
| Final focused: Trading + Core foundation/actions/policy authority | 76 | 0 / 0 / 0 |
| Market, Economic, migration completion, workloads, proxy, manual lifecycle, lifecycle, storage regressions | 255 | 0 / 0 / 0 |
| Browser smoke, including recommendation/HOLD | 1 scenario | 0 / 0 / 0 |
| Syntax: all source/tests/scripts | 180 files | 0 |
| One final `npm test` (48,938.2002 ms) | 567 | 0 / 0 / 0 |

Logs: `artifacts/trading-focused-final.log`, `trading-regressions.log`, `trading-browser.log`, `trading-full-suite.log`. Development found and corrected a quantity fixture whose stated supply could not cover its lot, and a browser fixture that advanced the market revision twice. Chrome required execution outside the sandbox after sandbox startup returned EPERM; the isolated smoke then passed.

## Limits and autonomous-execution readiness

Observed listings are offers, not demand or confirmed sales. Recommendations use one visible market snapshot and one whole lot; availability, account balance, current inventory, listing capacity and eventual sale are not guaranteed. The planner does not infer fees, liquidity, sale velocity, portfolio risk or settled profit. Historical medians influence existing confidence/volatility; no additional forecast is introduced. Work per evaluation scales with configured items/markets; history is bounded per scope, not globally archived.

Before autonomous execution: explicit operator authorization and an audited admission path; inventory/capital/exposure policy; target-market and bot readiness binding; fresh pre-purchase evidence; idempotent plan-to-workload conversion; sale/settlement and cost evidence; residual/uncertain reconciliation; live protocol validation; operational stop controls and monitoring. This milestone grants none of that execution authority.
