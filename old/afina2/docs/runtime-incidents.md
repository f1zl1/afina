# FunTime incidents and test-account replacement

Implemented on SQLite schema **v7**. This is an extension of the existing worker,
account assignment and Core reconciliation paths. Automatic replacement and
automatic generation both default to **off**; the account generation cap defaults
to **0**. No live FunTime test was performed.

## Architecture and existing functionality reused

- `MessageEvents` accepts trusted server/system messages; `ConnectionEvents`
  converts kick components to text. `normalizeFunTimeIncident()` is the single
  home of the new FunTime message patterns. Player chat cannot trigger them.
- `RuntimeIncidents` belongs to one `Bot` runtime. Reseller's existing
  `InventoryActions`, inventory operation lock and `ResellerServerActions` queue
  continue to own inventory operations. No inventory slots are manually mutated.
- Workers emit local events through `WorkerEventBus`; the existing public event
  mapping/normalizer and IPC deliver them to `BotProcess`. Its pre-publication
  hook lets `BotManager` persist a ban before publishing it on the main EventBus.
  SQLite remains exclusively in the main process.
- `Core` → `AutonomousCore` → `CoreActualState` / `CoreDecisionEngine` →
  `CoreReconciler` is still the reconciliation path. `AccountReplacements` is a
  Reconciler action implementation, not a separate launcher.
- Selection uses the existing `AccountAssignmentService.rotateAccount()` and
  transactional `DataBaseManager.assignAvailableAccount()`. Starting uses the
  existing `CommandService` → `BotManager.startBot()` → configuration preparation
  → fresh `BotProcess` / worker lifecycle.
- The existing generator is **`DataBaseManager.createGeneratedAccounts(count,
  credentials = generateCredentials, onCreated = null)`**. Core requests one
  account at a time. `generateCredentials()` in `accounts/accountCredentials.js`
  still creates readable nicknames and cryptographically random 24-character
  passwords. Existing nickname collision retries and batch limits remain.
  The only generator extension is an optional synchronous transaction callback:
  the request's new account ID is committed atomically with `accountsData` and
  `accountPoolState`. Callback failure rolls everything back. Public return data
  contains IDs, usernames and pool status, never passwords.
- A generated record being `available` means assignable for **initial startup**,
  not operational. Registration, authentication, existing Telegram binding when
  required, hub/realm entry and readiness use the normal Bot lifecycle. No new
  registration or Telegram implementation was introduced.

## Runtime behavior

| Incident | Behavior |
| --- | --- |
| `ITEM_DROP_REJECTED` | Correlate with the single pending drop, current client and a 1,500 ms window. Reject that operation and remember only its conservative item identity. Uncorrelated messages produce diagnostics without ignoring an item. |
| `EMPTY_ITEM_SELL_ATTEMPT` | Correlate with the active sale, abort its response waiter, yield through the inventory delay, and re-read/re-prepare inventory on the next normal cycle. Never emit a successful listing or add AIR to ignored items. |
| `INVENTORY_BLOCKED_BY_IGNORED_ITEMS` | Latch an operational block, cancel movement/recovery and stop the role safely. Keep the worker alive and inhibit supervisor/configuration automatic restarts. It is not an account ban. |
| `CHEAT_CHECK_REQUESTED` | Use existing `sendChat()` to send exactly `у меня чит`. Deduplicate conservatively for the runtime session; stop, disconnect or a changed client cancels an imminent response. No other check automation. |
| `ACCOUNT_BANNED` | Persist ban/history and pool ineligibility first, publish the semantic incident, stop the worker through BotManager and block reconnect. |

Pending drop/sale context includes operation ID, slot, item ID, amount, timestamp
and identity. Sale correlation starts when the queued command is actually sent,
not while waiting in the server action queue. Drops are serialized through their
response window; cancellation releases their waiter and existing role cleanup
releases inventory ownership.

Ignored identity is SHA-256 of a canonical representation of item type, name,
metadata, NBT and components. Count and slot are not identity, so moving/splitting
an otherwise identical protected stack cannot cause repeated attempts. Different
metadata is not globally blacklisted. The set resets with the runtime session;
there is no inventory observation table.

Ignored items are excluded from cleanup, stock lookup and sale preparation. If a
protected item occupies the sell slot, the existing inventory transaction moves
it to a free main-inventory slot, never equipment or the configured sell slot.
The authoritative Mineflayer slot results are checked before continuing. A full
inventory with no usable stock/space, or an obstructed work slot with no safe
destination, becomes `INVENTORY_BLOCKED_BY_IGNORED_ITEMS`. The operator can fix the
inventory and restart manually; Core does not repeatedly restart it to clear the
condition. A restart alone does not change server-side inventory contents.

An empty sale is temporary, with a new operation ID on each later attempt and
normal Reseller retry delays. Repeated failures remain visible in incident
history. No auction parsing or pricing logic was changed.

## Ban parsing, persistence and restart safety

Detection uses semantic ban markers, removes Minecraft formatting codes, and
tolerates case, whitespace, newlines, surrounding text and missing fields. Reason,
issued time, remaining duration and punishment ID are parsed independently,
including fields on a single line. An unrecognized optional field does not hide
the ban.

`accountsData` gains `banned`, `disabled`, and `currentBanId`.
`accountBanHistory` stores:

- account ID, detection timestamp;
- issued timestamp (nullable) and exact raw issued-time text;
- reason, remaining duration text, optional estimated expiration;
- punishment ID, source, sanitized raw message and deduplication fingerprint;
- JSON context with observed nickname, bot ID, role, item, session start/uptime
  and applied configuration fingerprint when available.

An issued local date such as `19.09.2026 04:05:42` is **not assumed UTC**.
Expiration is estimated from detection time only for a wholly recognized numeric
remaining duration; otherwise it stays null. Expiration never automatically
restores eligibility.

Ban history insertion, current-ban update and pool blocking share one SQLite
transaction. Idempotency is account + punishment ID when present; otherwise a
conservative fingerprint uses issued text/reason/raw text without ticking
remaining-duration text. Unidentifiable identical bans are deliberately treated
as the same observation. Duplicate delivery does not add history, stop again or
notify again. After an explicit operator eligibility reset, observing the same
server ban restores the block while retaining the original history row.

Normal supervisor startup rechecks persisted account flags after configuration
preparation. A banned/disabled account cannot reconnect after process/application
restart. A persistence failure stops and inhibits that session, emits
`BAN_PERSISTENCE_FAILED`, and does not falsely report a saved ban.

The logical bot/task record remains for configuration and diagnostics. Its banned
account contributes zero eligible active capacity and cannot be selected. Runtime
task/lock ownership ends with normal worker shutdown. The old account/history are
never rewritten into the replacement identity.

The migration upgrades the existing database transactionally, validates integrity
and foreign keys, and creates the existing pre-upgrade backup
`backups/<timestamp>-v7/afina-before-v7.db`. Ban history and replacement requests
are read-only in the generic database editor. Existing data is preserved.

## Core policy and reconciliation

| Persisted policy | Default | Meaning |
| --- | --- | --- |
| `autoReplaceBannedAccounts` | `false` | Restore still-desired reseller/analyst workloads after a ban. Requires Core `enabled`. |
| `allowAutomaticAccountGeneration` | `false` | Permit the existing generator only when no eligible existing account can cover that replacement. |
| `maxAccounts` | `0` | Maximum total persisted Minecraft accounts for **automatic generation**, including banned/disabled accounts. Zero prohibits generation. Does not prevent using existing eligible accounts or change the manual generator. |

These use the normal Core policy API, optimistic revision, persistence and visible
**Ядро** controls. Existing worker targets, per-item desired allocations, item
disabling/limits, price overrides and manual holds still constrain replacements.
The feature restores an existing configured workload; it does not invent prices,
enable autonomous trading decisions or create extra logical bots.

Core first subtracts healthy capacity, existing initializations and already
reserved workload from the deficit. Existing pending replacements take priority
independently of bot ID ordering. It then selects a stable eligible pool account
(`lastUsedAt`, then account ID). Banned, disabled, blocked/retired, unexpired
cooldown, assigned/conflicting and reserved accounts are excluded, including
in-memory AccountPool reservations and durable replacement reservations.

Only a remaining real deficit, both permissions and room below `maxAccounts`
permit generation. No account is created when a stopped eligible spare exists.
If permission/limits prevent creation, the request becomes `deficit` with
`GENERATION_DISABLED` or `ACCOUNT_LIMIT_REACHED`, emits `ACCOUNT_CAPACITY_DEFICIT`
and retries only after the existing `failureRetryMs`. No zero-delay creation loop.

`accountReplacements` records request ID, logical bot, triggering banned account,
replacement account, original requested role/assignment, creation/update times,
state, failure/retry information, whether generation occurred and decision ID.
A partial unique index allows only one active request per bot. This also allows
a subsequently reused account to have a new, independently audited replacement.

Lifecycle:

`requested → generating → created → selected → initializing → completed`

Existing-pool selection skips generating/created. Failures/deficits retain the
request and any committed account ID. Core reconciliation is serialized, request
state is durable, and creation + its result pointer are one transaction. Repeated
evaluations, duplicate bans and restart recovery reuse committed work instead of
generating another account for the same pending deficit.

`initializing` does not count as a healthy worker. Completion requires the new
account on that bot, the expected running role and `bot.runtime.ready` after the
realm readiness gate with a live role. A created DB row or a process spawn is not
completion. `actionTimeoutMs` produces a controlled initialization failure; a
worker that later becomes ready can still settle the same request. Retries use
`failureRetryMs` and reuse a still-eligible created account.

Policy, manual control, task and eligibility are checked again across asynchronous
selection/start boundaries, including inside the assignment queue. A committed
creation survives a later policy cancellation; no further launch is authorized by
the obsolete revision. Turning replacement off keeps normal ban safety and
diagnostics but prevents this feature from selecting/generating/starting a
replacement. An initialization already legitimately started may finish and be
reported as such.

The same **botId**, server, realm, task, item and configured prices survive;
**accountId changes**. A fresh worker receives configuration only. Inventory,
windows, pending clicks/sales, locks, movement and Mineflayer state are not copied.

## Events, audit and panel

Existing envelope format: `{id, version, type, timestamp, source, payload}`.
Source holds bot/account/worker identity. Contracts validate the new event
payloads; all events travel through existing IPC/EventBus/InterfaceGateway/WS.

- `bot.runtime.incident`: payload `type` is one of the semantic runtime incidents,
  plus timestamp and applicable sanitized raw/parser/operation/item metadata.
  Bans gain durable `banId`, account ID and previous role/assignment in main.
- `bot.runtime.ready`: the existing role lifecycle reports readiness for Core.
- `core.account.incident`: payload `type` is `ACCOUNT_REPLACEMENT_REQUESTED`,
  `ACCOUNT_REPLACEMENT_SELECTED`, `ACCOUNT_GENERATION_REQUESTED`,
  `ACCOUNT_GENERATED`, `ACCOUNT_REPLACED`, `ACCOUNT_REPLACEMENT_FAILED`, or
  `ACCOUNT_CAPACITY_DEFICIT`. Includes bot ID, banned/replacement account IDs,
  request ID, cause, requested role, timestamp and applicable failure/capacity
  details. Subscribe and filter `payload.type` for future notifications.

Runtime incidents and Core account events use existing event persistence. Core's
decision journal records ban/replacement transitions; the replacement action
stays `applying` until operational completion. Pending decision records are
protected from normal journal pruning. No passwords enter these payloads, history
context or decisions. There are no direct Telegram notification calls.

The bot list shows **Banned** / **Blocked** with a red status dot. Bot details show
ban reason/dates/duration/ID or affected inventory slots/items. Raw server text is
escaped and collapsed in diagnostic details, not the main table. The list also
refreshes when a non-selected bot reports an incident. Core displays replacement
accounts, stages and failure/deficit reasons, and the policy controls are visible
outside advanced runtime/market settings. Database views expose ban history and
the durable request ledger for inspection.

## Files changed for this extension

- New: `src/incidents/{funtimeIncidents,incidentStore,incidentPolicy}.js`,
  `src/minecraftBot/runtime/runtimeIncidents.js`, `src/core/accountReplacements.js`,
  `tests/runtimeIncidents.test.js`, this document.
- Storage/accounts: `src/data/{databaseSchema,databaseMigration,dataBaseManagerMain}.js`,
  `src/accounts/{accountPool,accountAssignmentService}.js`.
- Runtime: `src/minecraftBot/bot.js`,
  `src/minecraftBot/handlers/botEvents/{messageEvents,connectionEvents}.js`,
  `src/minecraftBot/runtime/antiAfkManager.js`,
  `src/minecraftBot/worker/roleLifecycle.js`,
  `src/minecraftBot/taskRunner/modes/reseller/{resellerInventory,resellerSeller}.js`,
  its `inventory/inventoryActions.js` and `server/resellerServerActions.js`.
- Main/Core/events: `src/botManager/{botManagerMain,botProcess,botConfigurationService}.js`,
  `src/core/{coreMain,corePolicy,coreStore,coreActualState,coreReconciler,autonomousCore,commandService}.js`,
  `src/events/{events,eventContracts,workerEventNormalizer,eventPersistence}.js`,
  `src/snapshots/botSnapshotStore.js`.
- Panel: `src/webTerminal/public/{app.js,styles.css}` and
  `src/webTerminal/public/js/{ui,coreController}.js`.
- Tests/docs: `tests/{runtimeIncidents,botConfiguration,storageMigration,marketIntelligence,telegram}.test.js`,
  `tests/browserSmoke.mjs`, `docs/{core-foundation,runtime-reliability}.md`.
  Existing migration assertions were updated from v6 to v7; their checks were
  retained. Generated validation artifacts live in `artifacts/`.

## Validation

Final local verification (2026-09-19): **219/219 tests passed**, including 60 in
`runtimeIncidents.test.js` and one new configuration-restart regression test
(61 additions over the previous 158 tests). Browser smoke passed with no JS
exceptions. The current-database copy migrated to v7 with `integrity_check=ok`,
zero foreign-key errors, and the existing 13 accounts / 6 bots / 6 tasks retained.

`npm test` exercises normalization, operation correlation, ignored-item relocation
and blocking, empty sales, cheat response cancellation, transactional bans,
idempotency, eligibility, persisted startup refusal, Core policy/limits, existing
generator reuse, multiple bans, pending readiness, interrupted selection,
transaction rollback and restart recovery. No live credentials are used.

`npm run test:ui` runs the real frontend against an in-memory API in a disposable
headless Chrome profile. It covers new controls, persistence, live replacement
progress, safe ban details, inventory blocking, mobile layout and existing UI.

`npm run migration:check` upgrades a **copy** of the current database, validates
integrity/foreign keys and writes `artifacts/migration-preview.json`. It does not
migrate the running database. The normal next application startup performs the
actual upgrade and backup. Successful unit/browser tests are not a claim of live
FunTime compatibility.
