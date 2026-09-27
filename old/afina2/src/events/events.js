export const EventVersion = 1

export const Events = Object.freeze({
    BOT_STATUS_CHANGED: "bot.status.changed",
    BOT_SUPERVISOR_STATUS_CHANGED: "bot.supervisor.status.changed",
    BOT_DESIRED_STATE_CHANGED: "bot.desired.state.changed",
    BOT_POSITION_CHANGED: "bot.position.changed",
    BOT_BALANCE_CHANGED: "bot.balance.changed",
    BOT_CHAT_MESSAGE: "bot.chat.message",
    BOT_KICKED: "bot.kicked",
    BOT_DISCONNECTED: "bot.disconnected",
    BOT_ERROR: "bot.error",
    BOT_FATAL: "bot.fatal",
    BOT_CAPTCHA_DETECTED: "bot.captcha.detected",
    BOT_CAPTCHA_ERROR: "bot.captcha.error",
    BOT_AFK_DETECTED: "bot.afk.detected",

    TASK_STATE_CHANGED: "task.state.changed",
    TASK_ERROR: "task.error",

    RESELLER_PURCHASE_COMPLETED: "reseller.purchase.completed",
    RESELLER_LISTING_CREATED: "reseller.listing.created",
    RESELLER_RELIST_COMPLETED: "reseller.relist.completed",
    RESELLER_WAITING_FOR_SALE: "reseller.waiting-for-sale",
    RESELLER_OUT_OF_FUNDS: "reseller.out-of-funds",
    RESELLER_STORAGE_CHANGED: "reseller.storage.changed",

    WORKER_STARTED: "system.worker.started",
    WORKER_EXITED: "system.worker.exited",
    WORKER_UNRESPONSIVE: "system.worker.unresponsive",

    RECONNECT_SCHEDULED: "system.reconnect.scheduled",
    RECONNECT_EXHAUSTED: "system.reconnect.exhausted"
})

export const WorkerPublicEventMap = Object.freeze({
    'bot:runtimeIncident':'bot.runtime.incident',
    'bot:runtimeReady':'bot.runtime.ready',
    'bot:realmReadiness':'bot.realm.readiness',
    ...Object.fromEntries(['scheduled','started','forwardCompleted','returnCompleted','completed','deferred','cancelled','failed','diagnostic'].map(type=>[`bot:antiAfk:${type}`,`bot.antiAfk.${type}`])),
    ...Object.fromEntries(['started','hubRequested','hubConfirmed','realmRequested','realmConfirmed','ready','completed','failed','cancelled'].map(type=>[`bot:afkRecovery:${type}`,`bot.afkRecovery.${type}`])),
    'bot:analysis.status':'bot.analysis.status',
    'bot:economic.result':'bot.economic.result',
    'bot:analysis.progress':'bot.analysis.progress',
    'bot:analysis.observation':'bot.analysis.observation',
    'bot:analysis.completed':'bot.analysis.completed',
    'bot:analysis.failed':'bot.analysis.failed',
    "bot:statusChanged": Events.BOT_STATUS_CHANGED,
    "bot:positionStatusUpdated": Events.BOT_POSITION_CHANGED,
    "bot:balanceUpdated": Events.BOT_BALANCE_CHANGED,
    "bot:chatMessage": Events.BOT_CHAT_MESSAGE,
    "bot:kicked": Events.BOT_KICKED,
    "bot:disconnected": Events.BOT_DISCONNECTED,
    "bot:error": Events.BOT_ERROR,
    "bot:fatal": Events.BOT_FATAL,
    "bot:captchaDetected": Events.BOT_CAPTCHA_DETECTED,
    "bot:captchaError": Events.BOT_CAPTCHA_ERROR,
    "bot:afkDetected": Events.BOT_AFK_DETECTED,

    "bot:resellerStateUpdated": Events.TASK_STATE_CHANGED,
    "bot:resellerError": Events.TASK_ERROR,

    "bot:itemPurchased": Events.RESELLER_PURCHASE_COMPLETED,
    "bot:itemListed": Events.RESELLER_LISTING_CREATED,
    "bot:itemsRelisted": Events.RESELLER_RELIST_COMPLETED,
    "bot:resellerWaitingForSale": Events.RESELLER_WAITING_FOR_SALE,
    "bot:resellerOutOfFunds": Events.RESELLER_OUT_OF_FUNDS,
    "bot:auctionStorageFull": Events.RESELLER_STORAGE_CHANGED,
    "bot:auctionStorageAvailable": Events.RESELLER_STORAGE_CHANGED
})
