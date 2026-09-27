# Operations Automation v1

> **Phase 5 update — 2026-09-26:** [Lifecycle arbitration and graceful stopping](core-v2-phase5.md) now uses the shared action ledger, durable recovery state (schema v11), correlated quiescence, and truthful lifecycle settings/diagnostics. Historical lifecycle limitations below describe their original delivery. Autonomous Reseller trading remains disabled.

> **Current after Phase 1 — 2026-09-25:** The original v1 description below is retained as historical documentation. The [Phase 1 implementation report](core-v2-phase1.md) supersedes its authority and capability claims. SQLite v9 makes Operations the only operational authority. Global target is derived; global/role/reserve minima, stability, transition, role-specific autoStart/autoReplace/stopMode and restart/health controls are stored but unsupported. Role targets remain within role maxima; inert minima cannot independently invalidate target edits. Priority clips targets, not account-assignment order. Maintenance blocks new Core actions/analysis but does not drain bots or revoke supervisor recovery. Ordinary autonomous Reseller execution remains blocked. Both existing generation paths share canonical permission/limits, and the existing replacement executor retains its stages. UI compatibility controls are read-only; runtime saves submit only explicit changes. See the linked report for current shape, consumer matrix, conservative migration rules and remaining Phases 2–7.

Operations Automation extends the existing `AutonomousCore → DecisionEngine → DesiredState → Reconciler → BotManager` flow. The browser edits policy; it never starts or stops workers to implement a schedule. SQLite v8 stores the revisioned policy in `operationsPolicy`. `automationEnabled` defaults to `false`.

The base policy defines global and generic per-role `minimum / target / maximum` values. All triples must satisfy `0 <= minimum <= target <= maximum`; invalid writes are rejected without reordering. Roles also define priority, `autoStart`, `autoReplace`, and `immediate`, `graceful`, or `finishCurrentCycle` stop intent. Hard limits and manual holds take precedence, followed by maintenance, schedule, global capacity, role priority, stability, and normal target recovery. Ties use the role identifier.

## How Core reacts to settings

A committed form is validated and persisted atomically, increments the policy revision, and immediately queues one coalesced Core evaluation. Core calculates the effective policy, writes a revisioned DesiredState, reconciles it against ActualState, executes lifecycle actions through BotManager, and evaluates again from semantic lifecycle events until stable or explicitly blocked. The periodic safety reconciliation only recovers missed events; it is not the normal policy-application path. Evaluation is single-flight, and execution guards reject actions whose policy/input revision became stale.

`minimum` is a health boundary and never replaces the target. `target` is the exact desired operating point under normal conditions. `maximum` is a hard autonomous ceiling. The desired global count is derived from effective role targets; the stored legacy global target is not an independent allocator. Global minimum and maximum remain system constraints. A disabled role has effective minimum, target, and maximum of zero.

If no schedule window matches, the base role policy is inherited. An active window replaces only its explicit enabled state and complete capacity override. Overlapping enabled windows for the same role and local minute are rejected, including overlaps across midnight. Maintenance sets managed role goals to zero. Automation disabled retains diagnostic desired/preview information but performs no lifecycle mutation.

Actual running capacity counts only workers in the operational runtime state with an enabled active task and no operational/ban block. Starting and stopping workers are exposed separately and reduce the remaining unresolved deficit/excess so repeated evaluations do not request the same work. Manual holds remain hard overrides.

The snapshot exposes configured, effective, desired, actual, starting, stopping, remaining deficit/excess, blockers, the triggering event, policy and desired revisions, planned actions, and the authoritative next schedule transition. Resource shortages do not lower DesiredState; they remain visible as structured blockers.

Weekly schedule windows use ISO weekdays (Monday 1 through Sunday 7) and an explicit IANA timezone. `Intl.DateTimeFormat` supplies timezone/DST conversion. A cross-midnight window belongs to its start day. An active window inherits the base role policy and replaces only its explicit `roleEnabled` and complete capacity triple. Core publishes the current profile, next boundary, and before/after role changes, and arms a revision-aware wakeup for that boundary. The normal safety reconciliation remains as a fallback.

Maintenance blocks starts, replacement, and generation and drives managed targets toward zero. `restoreDesiredState` evaluates the current schedule at startup; `keepStopped` keeps startup stopped until an operator saves Operations Policy. Persistent manual holds remain authoritative. Bans are permanent account unavailability; quarantine is temporary and does not clear bans.

Reserve assessment counts only unassigned, enabled, non-banned accounts whose pool state is available (or whose cooldown has expired). Pending generated replacements reduce the exposed deficit. Automatic generation is intended to call the existing `accounts.generate`/`createGeneratedAccounts` lifecycle and must obey reserve, pending, and total limits; no second generator is introduced.

## Example

```json
{
  "automationEnabled": true,
  "maintenanceMode": false,
  "timezone": "Europe/Oslo",
  "startupPolicy": "restoreDesiredState",
  "capacity": {"minimum": 1, "target": 9, "maximum": 12},
  "roles": {
    "analyst": {"enabled": true, "minimum": 1, "target": 1, "maximum": 2, "priority": 100, "autoStart": true, "autoReplace": true, "stopMode": "graceful"},
    "reseller": {"enabled": true, "minimum": 0, "target": 8, "maximum": 10, "priority": 80, "autoStart": true, "autoReplace": true, "stopMode": "finishCurrentCycle"}
  },
  "schedules": [
    {"id": "reseller-day", "role": "reseller", "weekdays": [1,2,3,4,5,6,7], "start": "07:00", "end": "23:00", "enabled": true, "roleEnabled": true, "capacity": {"minimum": 4, "target": 8, "maximum": 10}}
  ]
}
```

The remaining transition, recovery, health, stability, and reserve objects use the defaults returned by `core.getSnapshot`. Contextual help comes from the backend `operationsHelp` registry and is associated with the Operations editor; validation messages remain separate.
