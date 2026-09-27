# Core Foundation v1

> **Phase 5 update — 2026-09-26:** [Lifecycle arbitration and graceful stopping](core-v2-phase5.md) now uses the shared action ledger, durable recovery state (schema v11), correlated quiescence, and truthful lifecycle settings/diagnostics. Historical lifecycle limitations below describe their original delivery. Autonomous Reseller trading remains disabled.

> **Поточний стан після Phase 1:** SQLite v9; єдина операційна політика — `operationsPolicy.document`. Головний перемикач, цілі ролей, генерацію та заміну редагуйте в операційному розділі. Старі поля Core — лише представлення сумісності; параметри виконання й аналізу мають окремі групи. Нове встановлення вимкнене, а під час оновлення наявний намір мігрується за явними правилами конфліктів. Задайте також загальний максимум. Аналітики мають наявний виконавець; звичайна автономна торгівля перепродажників залишається заблокованою. Обслуговування блокує нові дії ядра, але не зупиняє активні боти та перезапуски наглядача. Повний поточний контракт, міграція та перевірки: [Core v2 Phase 1](core-v2-phase1.md). Нижче збережено історичний опис foundation v1.

Поточне розширення: [інциденти FunTime та заміна тестових акаунтів](runtime-incidents.md),
SQLite v7; також доступні [Market Intelligence + Autonomous Analyst](market-intelligence.md).
Опис нижче фіксує foundation v1; Analyst/MarketModel тепер реалізовані,
а production autonomous reseller execution заблоковано до Trading Intelligence.

Відкриття: `npm start` → `http://127.0.0.1:4000` → **Ядро**.
Після міграції Core **вимкнено**, цілі — 0. Вкладка вже показує actual state,
desired allocation, поточну оцінку та рішення. Задайте цілі й overrides та увімкніть
Core, коли готові дозволити автономні запуски. Кнопка **Оновити** також скидає
незбережені поля форми до актуальних значень; це потрібно після `CORE_CONFLICT`.

## Інтеграція

`Core` лишається існуючим фасадом. `AutonomousCore` координує
`CoreStore` → `CoreActualState` → `CoreDecisionEngine` → `CoreReconciler`.
Використані наявні SQLite connection, EventBus, InterfaceGateway, CommandService,
BotManager та WebSocket. Нових dependencies немає.

Actual — проєкція botData/tasksData/accountPoolState та runtime BotManager,
із розділенням збереженого task і завантаженого активним процесом task.
Reseller рахується як actual лише коли процес працює, runtime має `running`
і його активне завдання увімкнене. Набір конфігурацій читається пакетно й
кешується за dataRevision. Секретні колонки не читаються проєкцією.

## SQLite v4

Міграція автоматична при запуску. Перед оновленням версій 1–3 створюється
`backups/<timestamp>-v4/afina-before-v4.db`; зміни схеми транзакційні.
Існуючі акаунти, Telegram sessions, прив’язки й tasks зберігаються.

| Таблиця | Призначення |
|---|---|
| corePolicy | Singleton, валідована політика |
| coreItemOverrides | Один override на itemId, FK до itemsData |
| coreMetadata | Revision policy/overrides для optimistic concurrency |
| coreDesiredState | Останній JSON desired state, revision, generatedAt |
| coreDecisionJournal | Structured decisions, unique decisionId, bounded retention |
| coreBotControl | Manual hold, assignment/switch timestamps, pending action, retry deadline |

Generic Database editor показує Core-таблиці тільки для читання; зміни policy
проходять через Core commands. coreMetadata — внутрішня таблиця.
Журнал зберігає останні `journalLimit` записів та ще незавершені pending decisions,
не більше одного на бота. UI показує останні 50; API дозволяє до 200.

## DTO та validation

CorePolicy має:

- `enabled`, `autoAllocateBots`, `autoSelectItems`, `autoPricing`, `autoAnalysis`: boolean.
- `targetResellers`, `targetAnalysts`: integer 0–1000; `maxResellersPerItem`: 1–1000.
- `minimumAssignmentDurationMs`, `switchCooldownMs`: integer 0–604800000.
- `switchImprovementThresholdPercent`: number 0–1000.
- `decisionDebounceMs`: 20–10000; `safetyIntervalMs`: 10000–600000.
- `journalLimit`: 50–10000; `failureRetryMs`: 1000–3600000;
  `actionTimeoutMs`: 1000–600000.

Дефолти — в міграції: enabled=false, targets=0, max per item=3,
autoAllocateBots=true, решта auto-прапорців=false, assignment/cooldown=300000,
improvement=10%, debounce=250, safety=60000, journal=1000, retry/timeout=60000.

Override: `{itemId, disabled, minBots, maxBots, forcedBots, maxBuyPrice, minSellPrice}`.
Ліміти ботів nullable, integer 0–1000; ціни nullable, positive finite number
0.000001–1e15. Перевіряються min ≤ forced ≤ max, якщо відповідні поля задано.
`null` прибирає окреме обмеження. Disabled забороняє allocation; forced задає
бажану точну кількість у межах загальної цілі та effective per-item max.
Конфлікт місткості пояснюється `OVERRIDE_CAPACITY_CONFLICT`.

DesiredState: `{revision, inputRevision, generatedAt, roles, allocations,
unallocatedResellers, market, analysisTask, assessments}`. Allocation містить
itemId, desiredBots, ціни або null, priceSource, constraints та reasons.

DecisionRecord: `{decisionId, timestamp, updatedAt?, desiredRevision?, actionId?,
trigger:{type,source,details,coalescedTypes?}, action, target:{botId,itemId},
before, after, reasons:[{code,message,data}], constraintsApplied, alternatives,
result}`. Result: planned → applying → applied / blocked / failed.
Один actionId зберігається протягом виконання. Applied для запуску означає
спостережений потрібний runtime task, а не лише прийняття команди.

## API та події

Через наявний Gateway:

- Query `core.getSnapshot`, payload `{}`: status, policy, overrides,
  inputRevision, desiredState, actualState, assessment, allocations,
  recentDecisions, fields, capabilities.
- Query `core.decisions.get`, `{limit:50}`.
- Command `core.policy.update`, `{values:{...}, expectedRevision}`.
- Command `core.override.set`, `{itemId, values:{...}, expectedRevision}`.
- Command `core.override.delete`, `{itemId, expectedRevision}`.
- Command `core.bot.release`, `{botId}`: зняти ручний hold.

expectedRevision береться з inputRevision snapshot; застарілий запис відхиляється.
Події: `core.status.updated`, `core.policy.updated`, `core.override.updated`,
`core.desiredState.updated`, `core.decision.created`, `core.decision.updated`.
Вони проходять існуючим WebSocket незалежно від підписки на вибраного бота.
Статуси: starting, disabled, evaluating, reconciling, stable, degraded, error.

## Реальна поведінка та межі v1

Core детерміновано зберігає задані reseller allocations, застосовує overrides,
ліміти товару й загальний target. При autoSelectItems заповнює вільні слоти
товарами з однозначними цінами з tasksData в порядку itemId. Це не ranking
прибутковості. Різні ціни одного товару або порушення price override блокують
автопризначення; Core не придумує ціну.

Для придатного зупиненого бота Core зберігає task транзакційно, синхронізує
конфігурацію та викликає існуючий `bot.start` із перевірками актуальності після
асинхронних кроків і безпосередньо перед стартом worker. Потрібні сервер/realm,
доступний Minecraft-акаунт, відсутність manual hold/backoff та місце в target.
Нові визначення ботів і нові акаунти Core v1 сам не створює.

Активний reseller не зупиняється й не перепризначається: дія blocked із
`SAFE_TRANSITION_UNAVAILABLE`. Зменшення target не обриває поточні операції.
Нормальне перемикання також вимагає duration/cooldown та підтвердженого improvement;
hard override може обійти hysteresis, але не lifecycle safety або загальні ліміти.

Ручні команди запуску/зупинки/перезапуску/ротації та редагування bot/task
встановлюють persistent manual hold. Повернення контролю — кнопкою у вкладці.
Зміни policy/override скасовують ще не виконані дії старої ревізії. Вимкнення
Core припиняє нові автономні зміни, але не зупиняє вже запущені процеси.
Якщо скасування сталося після запису task, цей запис залишається видимим у БД,
а запуск скасовується; journal позначає незавершену дію, не приховує частковий запис.

Оцінки серіалізовані, події об’єднуються debounce, повторні незмінні рішення
не створюють duplicate execution. Є рідка safety-перевірка, bounded journal,
timeout очікування та backoff після помилки. Runtime status/поточна оцінка
відновлюються з реальних даних після запуску; policy, overrides, desired,
manual holds і journal зберігаються в SQLite.

MarketModel, AnalysisPlanner, PricingEngine, AllocationEngine — контракти в
`economicContracts.js`; провайдери зараз повертають unavailable/null. Analyst
execution і safe active handoff ще відсутні. Немає вигаданих demand, confidence,
profit/hour або market reasons. AutoPricing/AutoAnalysis чесно показують
недоступність реалізації.

## Перевірки та наступний етап

`npm test` — Core constraints, priority, hysteresis, concurrency, correlation,
failures, persistence, lifecycle cancellation, migration й наявні регресійні тести.
`npm run test:ui` — прихований Chrome, тестовий API, форми, realtime journal,
reload, disabled state, адаптивна верстка; screenshots у artifacts/core-*.png.
`npm run migration:check` — копія поточної БД, integrity/FK checks; production
DB не змінюється. Реальні Minecraft/Telegram з’єднання ці перевірки не запускають.

Наступний етап: визначити schema фактичних market observations з server/realm,
itemId, часом спостереження та походженням; підключити їх до MarketModel і freshness.
Після цього реалізувати Analyst execution contract та AnalysisPlanner поверх
цих даних. Окремо потрібен safe handoff контракт reseller перед автоматичним
перерозподілом активних ботів.
