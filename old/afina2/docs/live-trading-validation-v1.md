# Live Trading Validation v1

Implemented through the existing autonomous admission, Economic Workload, Reseller buyer/seller and worker event path. No live trade was performed; production policy and database were not changed.

## Contract

Canonical `operationsPolicy.liveValidation` defaults to `{enabled:false,itemId:null,maxQuantity:1,maxPurchaseCommitment:null,maxAutonomousWorkloads:1}`. The operator must select an enabled item and explicitly set a positive purchase cap. Validation is an additional restriction: normal autonomous, lifecycle, freshness, capacity, uncertainty and residual gates still apply.

Schema v16 adds a singleton durable fuse: `UNARMED → ARMED → CONSUMED`. Web operators explicitly arm/re-arm with autonomous trading OFF and the expected fuse generation. Arming rejects active autonomous work and applicable uncertainty/residual review. Item/cap changes invalidate the armed configuration. Consumption and economic row creation share one transaction, before dispatch or economic side effects; a failed insert rolls both back. Completion, failure, cancellation, uncertainty, restart and disabling never re-arm it. Existing plan idempotency still applies after explicit re-arm.

Effective execution quantity is exactly one; the TradingPlan remains unchanged. Commitment must fit both the normal autonomous cap and the explicit validation cap. At most one autonomous attempt is admitted until re-arm. Admission binds the selected bot, incarnation and proxy; pending execution cancels on incompatible changes instead of rebinding. Manual Economic Workloads and normal autonomous mode retain their existing behavior. Disabling validation also disables autonomous trading, avoiding accidental removal of its restriction while execution remains enabled.

## Preflight and evidence

`trading.liveValidation` exposes machine-readable blockers, checks, durable fuse, effective preview and consumed execution. Viewing it cannot submit or consume. Preview uses backend admission terms: plan/item/market, quantity and reduction, buy ceiling, sell target, maximum commitment, bot/incarnation and safe proxy facts. Autonomous OFF remains a blocker while allowing inspection. Execution revalidates current facts; a preview does not reserve a market offer.

Validation requires an eligible fresh connected Reseller and its current RUNNING proxy reservation with SOCKS transport-connected evidence. Public proxy data contains id/label, host/port, reservation/connectivity facts, never credentials. No direct-connection fallback was added.

The existing economic result event carries allowlisted diagnostic codes and numeric evidence. The persisted workload owns `sourcePlanId`, workload id, bot/incarnation and a bounded timeline (128 entries, preserving its first six). Existing incarnation, generation, sequence and counter fences reject stale evidence before it enters that timeline. Stages cover plan selection, admission, fuse consumption, creation, bot selection, dispatch, buy/search/confirmation, inventory before/after, attributed purchase, listing/server acknowledgement and terminal result.

The mechanics audit retained the existing AH search, lot selection/click, confirmation, inventory delta, listing preparation, `/ah sell` and server response handling. Added bounded diagnostics identify these stages. A missing confirmation slot after a lot click now produces an uncertain economic result. Purchase/listing ambiguity remains `UNCERTAIN`, with consumed fuse and no retry or replacement. Arbitrary transport exception text is excluded from economic diagnostic logs/results to avoid leaking credentials.

## First live run — manual operator checklist

These steps have **not** been executed during implementation.

1. Stop Afina and take a consistent backup of the configured database (`src/config/dataBaseManager.json`; default `src/data/afina.db`). Use SQLite backup facilities or preserve the stopped database and any WAL sidecars together. Verify the backup separately before restarting.
2. Keep exactly one enabled test item in autonomous scope; verify its identity and market/realm.
3. Prepare exactly one eligible Reseller for that item, with sufficient balance/inventory space and no manual hold or conflicting workload.
4. Verify its assigned proxy id/label, host/port, current RUNNING reservation and transport-connected evidence; resolve any connection failure first.
5. Verify the Analyst is producing fresh market evidence and a current, unexpired `BUY_RESELL` plan for the intended market. Resolve uncertainty/residual blockers.
6. Keep `autonomousTradingEnabled` OFF while configuring and reviewing.
7. Enable validation mode and select the test item through canonical policy controls; save successfully.
8. Verify the fixed execution quantity is one and the workload limit is one. If the plan quantity is larger, confirm the preview shows its reduction.
9. Enter a very small explicit purchase commitment cap appropriate to the test; inspect the normal autonomous cap too. Never rely on an inferred budget.
10. Explicitly arm the fuse. Confirm `ARMED` and the saved item/cap; any subsequent item/cap change requires explicit re-arm.
11. Inspect backend preflight and preview: exact bot/incarnation, proxy, item, market, quantity, buy ceiling, sell target, commitment and plan id. Proceed only when the sole remaining blocker is autonomous trading OFF. Recheck fresh evidence immediately before enabling.
12. Deliberately enable autonomous trading. Admission will revalidate current facts; it may reject if they changed.
13. Observe exactly one economic workload and `CONSUMED` fuse before dispatch. Follow its correlated timeline; do not issue a second manual economic action.
14. Disable autonomous trading after the attempt. The validation disable action also turns autonomous trading OFF. Do not treat disabling as proof that an already-issued server action did not occur.
15. Inspect the terminal evidence, actual inventory and AH listing manually. A listing acknowledgement proves neither sale nor settled profit. Record the workload and plan ids with the observed result.
16. Reconcile any `UNCERTAIN` outcome or residual inventory through existing operator controls before considering a second test. Keep autonomous OFF; require fresh evidence/a new eligible plan and explicit re-arm. Restarting or toggling validation must not reset the consumed fuse.

## Automated verification

All execution tests use temporary databases and mocked Minecraft transport; browser smoke uses an isolated mocked backend. Tests are not live validation.

| Check | Passed | Failed / cancelled / skipped |
|---|---:|---|
| New live validation tests | 42 | 0 / 0 / 0 |
| Validation + autonomous (47) + economic (46), focused final | 135 | 0 / 0 / 0 |
| Trading/Market/Analyst, lifecycle/proxy, workloads, migration/storage, policy/UI regressions | 241 | 0 / 0 / 0 |
| Browser smoke, including configure/arm/preview/timeline/disable | 1 scenario | 0 / 0 / 0 |
| Syntax checks across source/tests/scripts | 185 files | 0 |
| One final `npm test` (83,747.9251 ms) | 656 | 0 / 0 / 0 |

Logs: `artifacts/live-focused-final.log` (23,691.6758 ms), `live-regressions.log` (32,968.1626 ms), `live-browser.log`, `live-full-suite.log`.

## Remaining live uncertainties

Real FunTime GUI timing, response text and actual proxy transport have not been validated here. Quotes can disappear. The existing buyer purchases whole lots, so quantity one requires an eligible single-item lot; a bulk-derived plan may safely end without a purchase and still consume its attempt. Transport-connected evidence is ephemeral, while the consumed fuse survives restart. A listing acknowledgement is not sale/settlement evidence. There is no automatic retry, reconciliation, residual disposal, repricing or relisting. One application/Core lifecycle authority remains the supported deployment model.
