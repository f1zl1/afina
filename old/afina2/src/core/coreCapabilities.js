// Phase 1 contract: metadata describes existing executors; it never enables them.
export const supportedRoles=Object.freeze(['analyst','reseller'])
export const legacyOperationalFields=Object.freeze({
    enabled:'automationEnabled',targetAnalysts:'roles.analyst.target',targetResellers:'roles.reseller.target',
    autoAllocateBots:'allocationEnabled',autoReplaceBannedAccounts:'recovery.autoReplaceBannedAccounts',
    allowAutomaticAccountGeneration:'reserve.automaticAccountGeneration',maxAccounts:'reserve.maximumTotalAccounts'
})
const feature=(status,label,consumer,description,blocker=null)=>({status,supported:status==='SUPPORTED',label,consumer,description,blocker})
export function coreCapabilities({analystAvailable=true,generatorAvailable=true,foundation=false,lifecycleAvailable=false,autonomousTradingEnabled=false}={}){
    return {
        tradingIntelligence:feature('SUPPORTED','Trading Intelligence · рекомендації','TradingPlanner','Плани BUY_RESELL / HOLD з поточних ринкових даних. Виконання має окремий дозвіл.'),
        manualTradingExecution:feature('SUPPORTED','Ручне торгове завдання','EconomicCoordinator / Reseller','Оператор задає товар, ціни та кількість. Виконується лише на готовому перепродажнику; рекомендація не є дозволом на виконання.'),
        autonomousTradingExecution:feature('SUPPORTED','Автономне виконання угод','TradingExecutionCoordinator / EconomicCoordinator','Реальні купівлі та виставлення лише за явного дозволу й у межах ризику.',autonomousTradingEnabled?null:'TRADING_EXECUTION_DISABLED'),
        legacyConfiguredTrading:feature('UNSUPPORTED','Старий налаштований торговий цикл','вилучено з production ResellerTask','Конфігурація, перезапуск або зміна ролі не запускають торгівлю. Потрібне допущене Economic Workload.','LEGACY_TRADING_RETIRED'),
        automaticRelisting:feature('UNSUPPORTED','Автоматичне перевиставлення','немає production виконавця','Ядро не перевиставляє попередні лоти або залишки.','AUTOMATIC_RELISTING_DISABLED'),
        economicReconciliation:feature('PARTIALLY_SUPPORTED','Звірка економічного результату','EconomicCoordinator / оператор','Показує підтверджені дані, блокує повтор невідомої операції та зберігає ручну перевірку. Фактичний інвентар/лоти перевіряє оператор; невизначеність працівника не скидається.','EXTERNAL_VERIFICATION_REQUIRED'),
        analystExecution:feature(analystAvailable?'SUPPORTED':'UNSUPPORTED','Робота аналітика','AnalysisCoordinator / Analyst', 'Запуск доступних аналітиків і виконання аналізу; потрібні налаштовані боти та дозвіл на аналіз.',analystAvailable?null:'ANALYST_UNAVAILABLE'),
        resellerLifecycle:feature('PARTIALLY_SUPPORTED','Керування перепродажниками','LifecycleArbiter / AccountReplacements','Наявні цілі, дозволи, proxy та безпечна зупинка керують процесами; торговий план не створює бота.',autonomousTradingEnabled?null:'TRADING_EXECUTION_DISABLED'),
        resellerTrading:feature(autonomousTradingEnabled?'SUPPORTED':'UNSUPPORTED','Автономна торгівля','TradingExecutionCoordinator / EconomicCoordinator','Дозвіл торгівлі окремий від бажаної кількості ботів. Усі ліміти та готовність перевіряються повторно.',autonomousTradingEnabled?null:'TRADING_EXECUTION_DISABLED'),
        accountGeneration:feature(generatorAvailable?'SUPPORTED':'UNSUPPORTED','Створення акаунтів','CoreReconciler / AccountReplacements / DataBaseManager','Створює облікові дані в межах спільної політики. Реєстрація відбувається під час запуску бота.',generatorAvailable?null:'ACCOUNT_GENERATOR_UNAVAILABLE'),
        bannedAccountReplacement:feature('SUPPORTED','Заміна заблокованих акаунтів','AccountReplacements','Лише для потрібного налаштованого навантаження; спочатку наявний акаунт, генерація потребує окремого дозволу.'),
        gracefulManagedStop:feature(lifecycleAvailable?'PARTIALLY_SUPPORTED':'UNSUPPORTED','Безпечна зупинка керованих ботів','LifecycleArbiter / GracefulStop','Нові завдання блокуються; зупинка чекає завершення поточної роботи та підтвердження безпеки. Невизначений результат операції забороняє звичайну зупинку. Тайм-аут не дозволяє примусове завершення.','UNSAFE_STOP'),
        managedRestartPolicy:feature(lifecycleAvailable?'PARTIALLY_SUPPORTED':'UNSUPPORTED','Політика автоматичного перезапуску','LifecycleArbiter / ActionLedger','Дозволи, обмеження спроб і пауза відновлення зберігаються в базі. Вікно спроб і карантин не підтримуються.',autonomousTradingEnabled?null:'TRADING_EXECUTION_DISABLED'),
        healthQuarantine:feature('UNSUPPORTED','Автоматичний карантин','немає','Ручне блокування й облік банів працюють; автоматичні пороги здоров’я не реалізовані.','HEALTH_AUTOMATION_UNSUPPORTED'),
        maintenance:feature('PARTIALLY_SUPPORTED','Режим обслуговування','AutonomousCore / LifecycleArbiter','Блокує нові автономні запуски та відновлення. За увімкненої автоматизації й розподілу запитує безпечну зупинку; ручне утримання та небезпечна робота можуть затримати завершення.','UNSAFE_STOP'),
        schedules:feature('PARTIALLY_SUPPORTED','Розклад','effectiveOperationsPolicy','Змінює ефективні цілі. Виконання залежить від можливостей ролі; точне безпечне зменшення кількості не гарантоване.'),
        // Existing boolean response aliases are retained for older clients.
        market:true,analysis:analystAvailable,operationsAutomation:true,automaticPricing:false,
        automaticTrading:autonomousTradingEnabled,safeActiveReassignment:false,stoppedBotAssignment:analystAvailable||foundation
    }
}

const setting=(status,consumer,description,domain='operations')=>({status,consumer,description,domain,editable:['SUPPORTED','PARTIALLY_SUPPORTED','DOMAIN_MISMATCH'].includes(status)})
export function operationsSetting(path){
    if(path.startsWith('liveValidation.'))return setting('SUPPORTED','LiveValidation / EconomicCoordinator','Додатковий захист першої реальної операції: один товар, кількість 1, явний малий ліміт та одноразовий fuse. Перезаряджання лише оператором при вимкненій автономній торгівлі.')
    if(path.startsWith('autonomousTrading'))return setting('SUPPORTED','TradingExecutionCoordinator / EconomicCoordinator','Дозвіл реальних купівель і виставлення. Потрібні автоматизація Core, свіжий план, готовий бот і явні ліміти ризику. Вимкнення зупиняє новий допуск та запитує безпечне завершення активних завдань.')
    if(path==='maximumBotsPerProxy')return setting('SUPPORTED','ProxyStore / LifecycleArbiter','Максимум зарезервованих або запущених процесів на один проксі. Зниження не зупиняє поточні процеси.')
    if(path.startsWith('controller.'))return setting('SUPPORTED','AutonomousCore / CycleScheduler','Обмежує роботу одного циклу; відкладені кандидати перевіряються повторно. Не змінює цілі або права виконавців.','controller')
    const unsupported=description=>setting('UNSUPPORTED','немає',description+' Значення збережено для сумісності; воно не змінює виконання.')
    if(path.startsWith('roles.')&&!supportedRoles.includes(path.split('.')[1]))return unsupported('Ця роль не має виконавця.')
    if(path==='capacity.target')return setting('LEGACY','effectiveOperationsPolicy','Похідна сума цілей ролей. Збережене старе значення не керує роботою.')
    if(path==='capacity.minimum'||path.endsWith('.minimum')||path==='reserve.minimumReadyAccounts')return unsupported('Мінімум не забезпечує автоматичного відновлення нижньої межі.')
    if(path.endsWith('.autoStart'))return unsupported('Окремий дозвіл автозапуску для ролі наразі не підтримується.')
    if(path.endsWith('.autoReplace'))return unsupported('Автоматична заміна окремо для ролі наразі не підтримується; діє загальний дозвіл заміни заблокованих акаунтів.')
    if(path.endsWith('.stopMode'))return unsupported('Вибір режиму не підтримується: звичайна зупинка завжди чекає безпечної межі; значення immediate не дозволяє примусове завершення.')
    if(path.startsWith('transitions.'))return setting('SUPPORTED','LifecycleArbiter / BotManager','Обмежує паралельні переходи, інтервали або очікування підтвердження безпечної зупинки. Ручна команда обходить інтервали; тайм-аут не дозволяє автоматичне примусове завершення.')
    if(['stability.minimumBotRuntimeMs','stability.minimumBotDowntimeMs'].includes(path))return setting('SUPPORTED','LifecycleArbiter','Мінімальна тривалість роботи або простою за збереженими часами запуску/виходу. Відновлення після відмови та ручна команда обходять цю затримку.')
    if(/^(stability|health)\./.test(path))return unsupported('Цей параметр не має виконавця у поточному ядрі.')
    if(['recovery.restartOnCrash','recovery.restartOnDisconnect','recovery.restartOnUnexpectedStop','recovery.maximumRestartAttempts','recovery.restartDelayMinMs','recovery.restartDelayMaxMs'].includes(path))return setting('PARTIALLY_SUPPORTED','LifecycleArbiter','Керує відновленням через спільний журнал дій. Лічильник і пауза зберігаються після перезапуску; скидання після 60 секунд підтвердженої готовності. Відновлення Reseller потребує дозволу автономної торгівлі.')
    if(path.startsWith('recovery.')&&path!=='recovery.autoReplaceBannedAccounts')return unsupported('Автоматичне лікування акаунтів та ковзне вікно спроб ще не реалізовані.')
    if(path==='maintenanceMode')return setting('PARTIALLY_SUPPORTED','AutonomousCore / LifecycleArbiter','Блокує нові запуски та відновлення. За дозволу автоматизації й розподілу запитує безпечну зупинку; ручне утримання зберігає пріоритет.')
    if(path==='automationEnabled')return setting('SUPPORTED','AutonomousCore / LifecycleArbiter','Єдиний головний дозвіл автономних дій і відновлення. Ручні команди та завершення програми мають окремі права.')
    if(path==='allocationEnabled')return setting('SUPPORTED','CoreReconciler / LifecycleArbiter','Дозволяє призначення, відновлення й безпечну зупинку ботів; не активує автономну торгівлю.')
    if(path==='startupPolicy')return setting('SUPPORTED','AutonomousCore.start','Відновити цілі або залишити автономні дії зупиненими. Явне збереження операційної політики знімає стартове утримання.')
    if(path==='timezone')return setting('SUPPORTED','effectiveOperationsPolicy','Часовий пояс IANA для розкладу на сервері; часовий пояс браузера не змінює рішення.')
    if(path==='recovery.autoReplaceBannedAccounts')return setting('SUPPORTED','AccountReplacements','Єдиний дозвіл заміни заблокованих акаунтів для потрібного навантаження. Ручне утримання і вимкнена автоматизація блокують заміну; генерація має окремий дозвіл.')
    if(path.startsWith('reserve.'))return setting('SUPPORTED','CoreReconciler / AccountReplacements',({
        'reserve.automaticAccountGeneration':'Єдиний дозвіл автоматичного створення. Наявні придатні акаунти використовуються першими; ручне створення є окремою командою.',
        'reserve.maximumTotalAccounts':'Спільний ліміт усіх акаунтів, включно із заблокованими. Нуль забороняє автоматичне створення; ручна команда не обмежена цією політикою.',
        'reserve.maximumPendingAccountGeneration':'Ліміт незавершеного створення. Нуль забороняє автоматичне створення; ініціалізація вже створеного акаунта є іншим етапом.',
        'reserve.targetReadyAccounts':'Додатковий резерв придатних облікових даних. Нуль не забороняє створення для дефіциту робочої кількості; готовність у грі тут не перевіряється.'
    })[path]??'Параметр резерву придатних акаунтів.')
    if(path.startsWith('schedules'))return setting('PARTIALLY_SUPPORTED','effectiveOperationsPolicy','Тижневе вікно змінює ефективну ціль/стан ролі; через північ діє день початку. Поза вікном діє базова політика. Запуск і зупинка обмежені можливостями ролі.')
    if(path==='capacity.maximum'||/^roles\.[^.]+\.(enabled|target|maximum|priority)$/.test(path))return setting('PARTIALLY_SUPPORTED','effectiveOperationsPolicy / CoreReconciler','Цілі обмежуються загальним максимумом за пріоритетом ролі. Торгівля потребує окремого дозволу. Максимум обмежує план, а не гарантує зупинку вже активних ботів.')
    return unsupported('Невідомий операційний параметр.')
}
export function policySettingMetadata(policyFields,overrideFields,operations){
    const operational={}
    const walk=(value,prefix='')=>{for(const [key,v] of Object.entries(value)){
        if(['revision','updatedAt'].includes(key))continue
        const path=prefix+key
        if(v&&typeof v==='object'&&!Array.isArray(v))walk(v,path+'.')
        else operational[path]=operationsSetting(path)
    }}
    walk(operations)
    for(const key of ['id','role','weekdays','start','end','enabled','roleEnabled','capacity','capacity.minimum','capacity.target','capacity.maximum'])operational['schedules.*.'+key]=operationsSetting('schedules.*.'+key)
    const core=Object.fromEntries(Object.keys(policyFields).map(key=>{
        if(legacyOperationalFields[key])return [key,{...setting('LEGACY','CoreStore compatibility adapter','Сумісне представлення операційної політики; змінюйте відповідний параметр в операційному розділі.'),canonicalField:legacyOperationalFields[key]}]
        if(key==='autoPricing')return [key,setting('UNSUPPORTED','PricingEngine (недоступний)','Автоматичне визначення цін ще не реалізоване.','workload')]
        const runtime=key.startsWith('antiAfk')||key.startsWith('analysisRealmReady')
        const market=key.startsWith('analysis')||key.startsWith('market')||key==='autoAnalysis'
        const control=['decisionDebounceMs','safetyIntervalMs','journalLimit','failureRetryMs','actionTimeoutMs'].includes(key)
        return [key,setting('DOMAIN_MISMATCH',runtime?'AntiAfkManager / RealmReadyGate':market?'AnalysisCoordinator / AnalysisPlanner / MarketStore':control?'AutonomousCore / CoreStore':'CoreDecisionEngine / CoreReconciler',
            runtime?'Параметр виконання, підтримується у відповідному середовищі бота; не задає кількість ботів.':market?'Підтримуваний параметр аналізу ринку; потрібні дозвіл автоматизації та аналітик. Не активує торгівлю.':control?'Підтримуваний параметр поточного циклу ядра; не є політикою кількості ботів.':'Обмеження планування товарів. Торгове виконання потребує окремого дозволу й перевірки ризику.',runtime?'runtime':market?'market':control?'controller':'workload')]
    }))
    const overrides=Object.fromEntries(Object.keys(overrideFields).map(key=>[key,setting('PARTIALLY_SUPPORTED','CoreDecisionEngine / AnalysisPlanner / AccountReplacements','Обмежує товар у межах загальної цілі й лімітів. Не активує автономну торгівлю та не обходить ручне утримання.','workload')]))
    return {operations:operational,core,overrides}
}
