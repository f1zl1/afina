# Market Intelligence v1 + Autonomous Analyst v1

## Запуск і межі

`npm start` → `http://127.0.0.1:4000` → **Ядро**.
У policy встановіть `enabled=true`, `autoAllocateBots=true`, `autoAnalysis=true`
і потрібний `targetAnalysts`. Потрібні зупинені боти з server/realm і доступні
Minecraft-акаунти. Ручний hold знімається кнопкою **Повернути ядру**.
Core призначає Analyst і запускає його існуючим lifecycle. Якщо придатного бота
немає — показує `NO_ELIGIBLE_ANALYST`, не створює прихований окремий процес.

Цей етап — спостереження. У production Core автономні reseller-зміни заблоковані
з `TRADING_EXECUTION_DISABLED`. Уже запущені користувачем reseller не перериваються.
Market Intelligence не викликає купівлю, продаж, `/pay`, не змінює торгові ціни.
PricingEngine та AllocationEngine залишаються foundation-контрактами.

## Архітектура

Існуючий `AutonomousCore` використовує:

1. `MarketStore`: існуюче SQLite connection, sessions/raw observations/history/models.
2. `MarketModel`: реалізація наявного контракту, snapshot із реальними metrics.
3. `AnalysisPlanner`: itemsData → explainable priority → analysis task.
4. `AnalysisCoordinator`: reservations, кореляція результатів, cancellation і journal.
5. Існуючий `CoreReconciler`: призначення/запуск Analyst та зупинка зайвого idle Analyst.
6. Існуючі BotProcess IPC → WorkerEventBus → BotTaskRunner → AnalystTask.

Analyst отримує task від Core, не вибирає товар або кількість refresh самостійно.
Нових EventBus, WebSocket server, DB connection чи dependencies немає.
Mineflayer GUI-код розміщений у worker execution layer.

Source of truth товарів: `itemsData(itemId,name,searchQuery,matcher)`.
Source of truth власних ніків: усі `accountsData.username`, включно з неактивними.
Model/reservation ключ: **serverId + realm + itemId**. Ринки різних realm ніколи
не усереднюються. Actual exposure використовує завантажений task/target процесу;
Analyst із неприйнятою зміною конфігурації не отримує нове завдання.

## SQLite v5

Міграція автоматично робить backup через існуючий механізм, потім працює в
транзакції. `tasksData` перебудовується зі збереженням усіх рядків, FK, task IDs
та change tracking; CHECK дозволяє `analyst`. Існуючі акаунти, Telegram-сесії,
tasks, policy і overrides не скидаються. У CorePolicy додаються параметри нижче.

| Таблиця | Дані й індекси |
|---|---|
| analysisSessions | analysisId, item/bot/server/realm, workerPid, decisionId, inputRevision, timestamps/deadline, requested/completed observations, lotsObserved, status, failureCode, nextRefreshAt, task JSON |
| marketObservations | observationId, analysisId, ordinal, item/server/realm, observedAt, lots JSON; unique analysisId+ordinal, scope+item+time та time indexes |
| marketHistory | Один компактний summary на observation; scope+item+time та time indexes |
| marketModels | Остання модель, PK serverId+realm+itemId, observedAt, document JSON |
| marketMetadata | Singleton marketRevision |

Partial UNIQUE indexes на sessions забороняють два active tasks для одного бота
або одного item у тому самому server/realm. Status: planned, running, completed,
failed, cancelled, timed_out. Generic Database editor показує ці таблиці read-only.

Raw lot після нормалізації:

```js
{
  slot, amount, totalPrice, pricePerItem, seller, expires,
  ownership, classification, includedInIndependentMarket,
  exclusionReason, parseReason, segment, potentialSpread // останнє optional
}
```

Це parsed raw market data, без повного NBT/inventory/player secrets. Некоректні
числа зберігаються як null із INVALID classification, не як NaN/Infinity.
`totalPrice` завжди ціна всього лота; `pricePerItem = totalPrice / amount`.

## Класифікація

1. INVALID: amount не safe integer 1–4096, totalPrice не positive safe integer,
   nonfinite unit price, непрочитаний seller, malformed lot/parser failure.
   Межа 4096 — технічна валідація, не припущення про Minecraft stack size.
2. OWN_LISTING: нормалізований seller точно є у cached Set наших ніків.
   Порівняння ASCII, case-insensitive; видаляються кольори й зовнішні пробіли.
   Невідомий seller не вважається незалежним, бо не можна виключити ownership.
3. HIGH_PRICE_OUTLIER: правило нижче, лише для valid independent lots.
4. POTENTIAL_WHOLESALE_OPPORTUNITY: дешевий valid independent lot, правило нижче.
5. INDEPENDENT: решта valid independent sample.

Own та invalid ніколи не задають high fence. Власні лоти зберігаються raw,
але виключені з незалежних supply, median/percentiles, seller count і volatility.
Ніки читаються одним запитом при зміні dataRevision, не запитом на кожен lot.

### Точний high-outlier algorithm

Беруться **unit prices** незалежних valid lots поточного snapshot, один голос
на lot. Percentiles — лінійна інтерполяція у відсортованому масиві, позиція
`(n-1)*q`. `m=median`, `MAD=median(abs(price-m))`, `IQR=Q75-Q25`.

Якщо `n >= 5`:

```text
H = max(3*m, m + 6*1.4826*MAD, Q75 + 3*IQR)
pricePerItem > H → HIGH_PRICE_OUTLIER, excluded
```

Якщо n<5, статистичних доказів недостатньо: high fence=null, automatic high
exclusion не робиться, diagnostics.smallSample=true. Це консервативний верхній
поріг, відносний до конкретного item/scope, без абсолютного порога валюти.
При нульових IQR/MAD працює мінімальна відносна межа 3*m.
Модель не стверджує, що продавець справді використовує auction як storage.

Нижній хвіст не обрізається. За наявності ≥3 чистих retail lots їхня медіана
є retail reference. Якщо їх недостатньо, для cheap-signal дозволена медіана
всієї clean sample при ≥5 lots. Ціна ≤0.75 reference позначається potential
wholesale opportunity і **залишається** в independent sample.
`potentialSpread = retailReference - unitPrice`, тільки коли retail reference
доступна; інакше null. Це інформаційний spread, не гарантований прибуток.

## Amount segmentation

За замовчуванням, в одиницях товару на lot:

- retail: amount ≤4;
- medium: 4 < amount ≤16;
- bulk: amount >16.

Межі централізовані у persisted `marketRetailMaxAmount` та
`marketMediumMaxAmount`, доступні у policy UI; retail max < medium max.
Вони не залежать від припущення «всі товари stack to 64». Сегменти мають власні
lotCount, supply, min, median, mean, P10/P25/P50/P75/P90. Загальна медіана також
показується як diagnostic, не як універсальна ціна роздрібного продажу.

## MarketModel і час

Supply, lot counts, price distribution, seller count та opportunities беруться
з **останнього snapshot**, а не суми refresh. Власна supply — окрема.
Зникнення чужого лота нічого не доводить про продаж. `salesVelocity`,
`realDemand`, `profitPerHour` завжди null. Повторні observations — перевірки
ринку, не нові sales/events попиту.

Для часової статистики беруться максимум 60 останніх summaries за 24 години,
що закінчуються lastObservedAt. Зберігаються observationCount, volatility,
volatilitySampleCount і confidenceBase. dataAgeMs/freshness/confidence
обчислюються при читанні snapshot за поточним часом.

### Точна volatility

Нехай R — clean **retail medians** цих observations, без null.
При |R|<3 volatility=null. Інакше:

```text
volatility = 1.4826 * median(abs(R - median(R))) / median(R)
```

Це robust relative dispersion часових retail-медіан, не стандартне відхилення
доходностей і не швидкість продажів. Вона нечутлива до одиночного high listing,
відкинутого до розрахунку, але може бути нульовою при багатьох однакових медіанах.
За відсутності retail даних volatility недоступна; bulk не підміняє retail.

### Точна confidence і freshness

L — independentLotCount останнього snapshot; S — його independent sellerCount;
O — кількість recent observations у визначеній вище вибірці; V — volatility або 0,
якщо ще недоступна. При L=0 confidenceBase=0. Інакше:

```text
base = (0.45*min(L/20,1) + 0.25*min(S/5,1) + 0.30*min(O/5,1)) / (1+V)
age = max(0, now-lastObservedAt)
confidence = round(100*base*max(0, 1-age/(2*marketStaleMs)), 1)
```

Це deterministic data-quality heuristic 0–100, не calibrated probability чи
«AI confidence». Повторні перевірки можуть збільшити O, але не L/S/supply.
Freshness: fresh при age≤marketFreshMs, aging до marketStaleMs, потім stale.

Кожен summary містить segmentation і fingerprint набору власних ніків.
Після зміни segmentation/own accounts модель отримує requires_reanalysis і
confidence=0; показані ціни залишаються історичними. Нові volatility/confidence
не змішують summaries із різними правилами ownership/segmentation.

## AnalysisPlanner: точна формула

Для кожного item у scope Analyst:

```text
freshnessNeed = 80, якщо never analyzed; інакше 40*dataAgeMs/marketStaleMs
confidenceNeed = 20*(1-confidence/100)
observationNeed = 10*(1-min(observationCount/5,1))
volatilityNeed = 20*min(volatility/0.25,1), або 0 за відсутності metric
exposureNeed = 10*min(activeResellersOnThisItemAndScope/3,1)
priority = sum(contributions), округлення до 0.001
```

Для never analyzed confidence/observationCount=0, тому cold-start priority=110.
Age contribution **не обмежена зверху**: старі низькопріоритетні товари зрештою
отримують перевагу над volatile. Tie-break — itemId ascending.
Це не процент, priority може бути >100. Reasons містять реальні contributions:
NEVER_ANALYZED, DATA_STALE/DATA_AGING, LOW_CONFIDENCE, LOW_OBSERVATION_COUNT,
HIGH_VOLATILITY, ACTIVE_RESELLER_EXPOSURE. Немає HIGH_DEMAND/HIGH_PROFIT.

Disabled override, порожній/надто довгий query або query з переносом не eligible.
Зарезервований item пропускається. Після completion діє analysisMinRepeatMs,
після failure/cancel — failureRetryMs. Busy Analyst не отримує інший task.
Різні Analyst можуть аналізувати однаковий item лише на різних server/realm.

Кількість observations = analysisMaxObservations, якщо never analyzed,
confidence<50 або volatility>0.15; інакше analysisMinObservations.
Observation count **включає перший scan**: N observations = N−1 refresh.
Core Journal зберігає вибір, priority, reasons і до трьох alternatives.

## Analyst lifecycle і GUI safety

Task має analysisId, itemId, query, matcher, observationCount, timing та scope.
TaskRunner запускає Analyst після входу в realm. Mode слухає існуючі worker events
`core:analysis.assign` / `core:analysis.cancel`, повідомляє idle/busy/unavailable.

```text
/ah search <query>
→ wait windowOpen with slot data
→ validate generic_9x6 + auction/search title
→ scan slots 0–44
→ emit observation
→ wait minimum + positive jitter
→ click only refresh slot 45
→ wait confirmed window contents update
→ next observation
→ close owned window → completed → idle
```

Reuse: AuctionPriceParser.extractTotalPrice, nbtComponentToString, InventoryMatcher.
Seller/expiry читаються з lore. Refresh confirmation: Mineflayer
`setWindowItems:<id>` (працює й для незмінених contents) або зміни lot slots із
300 ms quiet period. Без підтвердження — REFRESH_TIMEOUT, а не вигаданий scan.
Під час очікуваного refresh підтримано перевідкриття GUI з новим windowId,
але лише зі збереженим auction title та правильною структурою вікна.

Точний інтервал:
`minimumRefreshIntervalMs + floor(U*(refreshJitterMs+1))`, U∈[0,1).
Persisted minimum не менше **5000 ms**, default jitter=1500 ms.
Після wait перевіряються cancellation і поточне вікно. Немає покупки лотів,
переходів сторінок або tight polling.

Timeout GUI, unexpected/closed window, disconnect, parser error, cancellation,
worker replacement і deadline обробляються структуровано. Помилка одного lot
створює INVALID, інші slots читаються. Timer/listener cleanup перевірений тестами.
TaskRunner stop скасовує job. Новий процес починає з unavailable, не успадковує idle
старого worker. Зайвий Analyst зупиняється лише після idle; активний reseller
для цієї мети не переривається.

Core приймає результат тільки від відповідного botId/workerPid/analysisId,
active session, чинної inputRevision, поточного task/target/item mapping і до deadline.
Вимкнення Core/autoAnalysis, manual hold та зміна policy скасовують поточний аналіз.
Після перезапуску застосунку interrupted sessions стають cancelled; старі jobs
не відтворюються. Уже прийняті коректні observations зберігаються; запізнілі — ні.

## Policy defaults

| Поле | Default |
|---|---:|
| analysisMinObservations / analysisMaxObservations | 3 / 5 |
| analysisRefreshIntervalMs / analysisRefreshJitterMs | 5000 / 1500 |
| analysisWindowTimeoutMs / analysisSessionTimeoutMs | 15000 / 240000 |
| analysisMinRepeatMs | 60000 |
| marketFreshMs / marketStaleMs | 300000 / 1800000 |
| marketRetailMaxAmount / marketMediumMaxAmount | 4 / 16 |
| marketRawRetentionHours / marketHistoryRetentionHours | 24 / 168 |
| marketRawLimit / marketHistoryLimit | 5000 / 20000 |

Validation також перевіряє порядок min/max, fresh/stale та достатність session
timeout для максимуму observations із GUI timeout і jitter. Зміни проходять
існуючу `core.policy.update` з expectedRevision, через **Market / Analyst · параметри**.

## Retention і DB growth

Raw — parsed lots JSON, максимум 45 slots на observation. Повторні snapshots
зберігаються з окремим observedAt; дубль доставки analysisId+ordinal ігнорується.
Великі NBT blobs не дублюються. History — summary на observation, без масиву
всіх raw lots; current model — один рядок на item/scope.

Raw видаляється за віком 24 год або cap 5000 observations. History — 7 днів або
20000 summaries. Completed/failed/cancelled sessions видаляються за history
retention/cap після очищення їх raw observations. Current models зберігаються
довше як останні відомі дані, зі stale age/confidence; їх кількість залежить від
числа відомих item/server/realm, а не кількості refresh.

Кожен cleanup видаляє до 100 прострочених та 100 понад cap рядків кожної таблиці;
великі накопичення очищаються поступово. Виклик — після observation та під час
рідкої Core reconciliation. SQL використовує time/scope/session indexes.
Немає синхронного VACUUM: SQLite повторно використовує звільнені сторінки;
файл на диску не обов’язково одразу зменшується.

Орієнтир розміру: 45 lots × ~300 bytes × 5000 ≈68 MB raw JSON; summaries
~1–5 KB × 20000 ≈20–100 MB, плюс sessions/indexes/WAL. Це оцінка, фактичний
розмір залежить від opportunities та строкових полів. Caps і retention
налаштовуються; після різкого зменшення caps можливе коротке перевищення під час
поступового cleanup. Raw data не пишуться в окремий нескінченний market log.

## API, події, UI

`core.getSnapshot` розширений `market:{status,revision,items}`,
`analysis:{activeSessions,analysts,priorities}`, `auctionConstraints`.
Не повертається повна raw history. `core.market.details` query приймає
`{itemId,serverId,realm,limit}`; limit 1–135, default45, максимум три останні snapshots.
Команди налаштувань — існуючі policy/override/bot commands, без нового transport.

Нові semantic events: core.analysis.started, core.analysis.progress,
core.analysis.completed, core.analysis.failed, core.market.updated,
core.analysisPlanner.updated. Journal використовує існуючі decision IDs/results;
analysisId є actionId. Completion містить observations, lotsObserved (читання,
не унікальні продажі), тривалість і counts останнього snapshot.

У **Ядро**: market overview, scope selection, percentiles і сегменти, own/outlier
counts, expandable classification diagnostics, Analyst progress/next refresh,
planner priorities/reasons. Відкриття/reload бере snapshot, далі існуючі WebSocket
events із coalesced refresh; немає polling кожні 500 ms.

Центральний future constraint: `auctionConstraints.maxActiveListingsPerAccount=5`.
Auction fee — 0 за умовою сервера; капітал не моделюється per-bot. Майбутній
Treasury має враховувати, що `/pay` можливий лише між ботами на одному realm.
Treasury/transfers зараз не реалізовані.

## Перевірки та відомі обмеження

- `node --test --test-isolation=none tests/marketIntelligence.test.js`:
  sanitization, amount awareness, exact metrics, fairness, reservations, Core roles,
  no autonomous trading, cancellation/timeouts/stale results, persistence/retention,
  v4 migration, scope isolation, mocked GUI та реальний TaskRunner/event contract.
- `npm test`: ці тести та Core/DB/lifecycle/наявні регресії. Foundation engine
  tests явно inject старі stub providers; production providers перевірені окремо.
- `npm run test:ui`: реальний frontend у Chrome з тестовим API, market details,
  classification, Analyst live state, priorities, realtime, reload, mobile.
- `npm run migration:check`: backup-копія поточної БД, integrity/FK checks;
  production DB не мігрується цим тестом.

**Live FunTime не перевірено.** Потрібно перевірити фактичні title/lore seller/expiry,
refresh packet pattern (включно з незмінними lots), /ah search query/matcher,
затримки й серверні rate limits. UI тип generic_9x6 сам по собі недостатній:
незнайома назва вікна завершує session з UNEXPECTED_WINDOW. Ідентичні slot-only
updates, які Mineflayer не публікує як зміни, можуть дати REFRESH_TIMEOUT.

V1 бачить лише поточні slots 0–44, не весь auction. Немає pagination, доказів
foreign sales, full demand, profit/hour, probabilistic profitability чи торгової
стратегії. Upper fence консервативна і не гарантує виявлення масової маніпуляції
цінами; thin markets <5 lots не обрізаються. Сегменти глобальні за кількістю,
не item-specific stack metadata. Невідомий формат seller робить lot INVALID.

Наступний етап — live-калібрування форматів і повноти спостережень, потім
Trading Intelligence з власними підтвердженими purchase/sale outcomes та
safe handoff reseller. Економічні рішення слід підключати лише після цих даних.
## Runtime extension (schema v6)

Analyst now waits for the persisted realm stabilization delay before its first auction command. Shared runtime Anti-AFK provides movement safe points between observations. See [runtime reliability](runtime-reliability.md) for defaults, cancellation, configuration and live validation limits. The market models and economic behavior described above remain unchanged.
