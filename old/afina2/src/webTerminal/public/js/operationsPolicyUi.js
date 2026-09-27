export const roleLabels={reseller:'Перепродажник',analyst:'Аналітик'}
export const stopModeLabels={immediate:'Негайно',graceful:'Безпечна зупинка',finishCurrentCycle:'Завершити поточний цикл'}
export const startupLabels={restoreDesiredState:'Відновити бажаний стан',keepStopped:'Залишити зупиненими'}
export const weekdays=['Пн','Вт','Ср','Чт','Пт','Сб','Нд']

export const sectionFields={
    controller:[['maxActionsPerCycle','Максимум дій за цикл','number'],['maxCandidatesPerCycle','Максимум кандидатів за цикл','number'],['cycleBudgetMs','Бюджет часу циклу','duration'],['yieldBudgetMs','Інтервал передачі керування','duration'],['continuationDelayMs','Пауза перед продовженням','duration'],['maxPassesPerDrain','Максимум послідовних циклів','number']],
    transitions:[['maximumConcurrentStarts','Максимум одночасних запусків','number'],['startIntervalMs','Інтервал між групами запуску','duration'],['maximumConcurrentStops','Максимум одночасних зупинок','number'],['stopIntervalMs','Інтервал між зупинками','duration'],['gracefulStopTimeoutMs','Тайм-аут безпечної зупинки','duration']],
    stability:[['scaleUpCooldownMs','Затримка після збільшення кількості','duration'],['scaleDownCooldownMs','Затримка після зменшення кількості','duration'],['minimumBotRuntimeMs','Мінімальний час роботи бота','duration'],['minimumBotDowntimeMs','Мінімальний час простою бота','duration']],
    recovery:[['restartOnCrash','Перезапускати після збою','boolean'],['restartOnDisconnect','Перезапускати після розриву з’єднання','boolean'],['restartOnUnexpectedStop','Перезапускати після неочікуваної зупинки','boolean'],['maximumRestartAttempts','Максимум спроб перезапуску','number'],['restartWindowMs','Період підрахунку спроб','duration'],['restartDelayMinMs','Мінімальна затримка перезапуску','duration'],['restartDelayMaxMs','Максимальна затримка перезапуску','duration'],['replaceUnhealthyAccounts','Замінювати несправні акаунти','boolean'],['autoReplaceBannedAccounts','Автоматично замінювати заблоковані акаунти','boolean']],
    health:[['maximumConsecutiveFailures','Максимум послідовних помилок','number'],['maximumCrashesPerWindow','Максимум збоїв за період','number'],['crashWindowMs','Період підрахунку збоїв','duration'],['maximumLoginFailures','Максимум помилок входу','number'],['maximumRealmEntryFailures','Максимум помилок входу в анархію','number'],['quarantineUnhealthyAccounts','Карантин для несправних акаунтів','boolean'],['quarantineDurationMs','Тривалість карантину','duration']],
    reserve:[['minimumReadyAccounts','Мінімальний резерв акаунтів','number'],['targetReadyAccounts','Цільовий резерв акаунтів','number'],['automaticAccountGeneration','Автоматичне створення акаунтів','boolean'],['maximumTotalAccounts','Максимальна кількість акаунтів','number'],['maximumPendingAccountGeneration','Максимум одночасних створень','number']]
}
export const sectionLabels={controller:'Планування циклів ядра',transitions:'Запуск і зупинка',stability:'Стабільність',recovery:'Відновлення',health:'Стан ботів',reserve:'Резерв акаунтів'}
export const help={
    automationEnabled:'Дозволяє Core самостійно запускати й зупиняти ботів відповідно до політики. Ручне керування залишається доступним.',
    maintenanceMode:'Блокує нові автономні дії ядра. Безпечне завершення роботи активних ботів ще не реалізоване; наглядач продовжує власні перезапуски.',
    timezone:'Часовий пояс IANA, за яким Core обчислює розклад і переходи літнього часу. Значення на сервері є авторитетним.',
    minimum:'Нижня межа збережена для сумісності. Автоматичне забезпечення цього мінімуму ще не підтримується.',
    target:'Нормальна бажана кількість. Core намагається підтримувати її не нижче мінімуму й не вище максимуму.',
    maximum:'Верхня межа планової кількості. Не гарантує зупинку вже активних ботів; підтримка залежить від ролі.',
    priority:'Визначає порядок обмеження цілей загальним максимумом. Більше число означає вищий пріоритет. Порядок фактичного призначення акаунтів цим параметром не керується.',
    stopMode:'Режим збережено для сумісності. Вибір безпечної зупинки чи завершення циклу ще не має виконавця.',
    schedule:'Розклад змінює ефективну політику, але не запускає боти напряму. Якщо кінець раніше початку, інтервал триває через північ. Використовується налаштований часовий пояс.',
    stability:'Ці збережені параметри стабільності ще не мають виконавця.',
    reserve:'Кількість готових доступних акаунтів понад уже використані. Акаунти, що створюються, враховуються для недопущення зайвих запитів.'
}

Object.assign(help,{
    automaticAccountGeneration:'Дозволяє Core використовувати наявний генератор акаунтів, коли доступних акаунтів недостатньо для поточної цілі або заданого резерву. Core спочатку використовує вже існуючі доступні акаунти; нові створюються лише для залишкового дефіциту.',
    targetReadyAccounts:'Кількість ДОДАТКОВИХ готових акаунтів у резерві. Значення 0 вимикає додатковий резерв, але НЕ забороняє створення акаунтів для активної цілі.',
    maximumTotalAccounts:'Жорсткий ліміт усіх наявних акаунтів, включно із заблокованими. Значення 0 забороняє автоматичне створення.',
    maximumPendingAccountGeneration:'Обмежує кількість акаунтів, які можуть одночасно створюватися. Якщо дефіцит більший, Core створює акаунти поступово.'
})

export function durationPresentation(ms){
    if(ms%3_600_000===0)return {value:ms/3_600_000,unit:3_600_000}
    if(ms%60_000===0)return {value:ms/60_000,unit:60_000}
    return {value:ms/1000,unit:1000}
}
export function durationMilliseconds(value,unit){return Math.round(Number(value)*Number(unit))}
export const deepClone=value=>JSON.parse(JSON.stringify(value))
export const supportLabels={SUPPORTED:'Підтримується',PARTIALLY_SUPPORTED:'Частково підтримується',UNSUPPORTED:'Не підтримується',LEGACY:'Сумісність зі старим інтерфейсом',DOMAIN_MISMATCH:'Окремий домен налаштувань'}
export function metadataHelp(metadata){return metadata?`${supportLabels[metadata.status]??'Стан невідомий'}. ${metadata.description} Споживач: ${metadata.consumer}.`:'Можливість не описана сервером; редагування недоступне.'}
export function explicitPolicyChanges(values,before,metadata){return Object.fromEntries(Object.entries(values).filter(([key,value])=>metadata?.[key]?.editable===true&&JSON.stringify(value)!==JSON.stringify(before[key])))}
