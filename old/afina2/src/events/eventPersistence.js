import { Events } from "./events.js"

export const PersistedEvents = Object.freeze([
    Events.BOT_STATUS_CHANGED,
    Events.BOT_SUPERVISOR_STATUS_CHANGED,
    Events.BOT_DESIRED_STATE_CHANGED,
    Events.BOT_POSITION_CHANGED,
    Events.BOT_BALANCE_CHANGED,
    Events.BOT_CHAT_MESSAGE,
    Events.BOT_KICKED,
    Events.BOT_DISCONNECTED,
    Events.BOT_ERROR,
    Events.BOT_FATAL,

    Events.TASK_ERROR,

    Events.RESELLER_PURCHASE_COMPLETED,
    Events.RESELLER_LISTING_CREATED,
    Events.RESELLER_RELIST_COMPLETED,
    Events.RESELLER_WAITING_FOR_SALE,
    Events.RESELLER_OUT_OF_FUNDS,
    Events.RESELLER_STORAGE_CHANGED,

    Events.WORKER_STARTED,
    Events.WORKER_EXITED,
    Events.WORKER_UNRESPONSIVE,
    Events.RECONNECT_SCHEDULED,
    Events.RECONNECT_EXHAUSTED
])

const persistedEvents = new Set(PersistedEvents)

export function shouldPersistEvent(type){
    return persistedEvents.has(type) || type==='bot.runtime.incident' || type.startsWith('core.account.') || type.startsWith("telegram.") || type.startsWith('bot.antiAfk.') || type.startsWith('bot.afkRecovery.') ||
        ['bot.realm.readiness','bot.analysis.status','bot.analysis.failed','bot.analysis.completed','core.analysis.started','core.analysis.failed','core.analysis.completed'].includes(type)
}
