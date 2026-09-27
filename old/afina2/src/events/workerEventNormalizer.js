import { Events } from "./events.js"
import {safeEconomicEvidence} from '../workloads/economicEvidence.js'

export function normalizeWorkerEvent(localType, publicType, payload = {}){
    if(publicType==='bot.economic.result')return Object.fromEntries(['workloadId','incarnationId','lifecycleEpoch','workloadGeneration','sequence','status','progress','operation','confirmedOperation','reason','evidence'].filter(k=>Object.hasOwn(payload,k)).map(k=>[k,k==='evidence'?safeEconomicEvidence(payload[k]):payload[k]]))
    if(publicType==='bot.runtime.ready')return {botId:payload.botId}
    if(publicType==='bot.runtime.incident')return Object.fromEntries(['type','botId','accountId','source','timestamp','rawMessage','banDetectedAt','banIssuedAt','banIssuedAtRaw','banReason','banDurationRaw','banExpiresAt','punishmentId','correlated','operation','affectedSlots','itemSummaries'].filter(k=>Object.hasOwn(payload,k)).map(k=>[k,payload[k]]))
    if(publicType.startsWith('bot.afkRecovery.')){
        return Object.fromEntries(['botId','accountId','generation','targetRealm','phase','timestamp','reason'].filter(key=>Object.hasOwn(payload,key)).map(key=>[key,payload[key]]))
    }
    if(publicType==='bot.realm.readiness'){
        return Object.fromEntries(['botId','phase','generation','oldPositionStatus','role','analysisId','evidence','evidenceRevision','timestamp','reason'].filter(key=>Object.hasOwn(payload,key)).map(key=>[key,payload[key]]))
    }
    if(publicType.startsWith('bot.antiAfk.')){
        return Object.fromEntries(['botId','accountId','role','realm','timestamp','mode','reason','stage','diagnostics','startPosition','endPosition','forwardDistance','returnDistance','durationMs','dueAt'].filter(key=>Object.hasOwn(payload,key)).map(key=>[key,payload[key]]))
    }
    if(publicType.startsWith('bot.analysis.')){
        const result={}
        for(const key of ['state','analysisId','workloadGeneration','ordinal','observedAt','lots','completedObservations','requestedObservations','nextRefreshAt','code']) if(Object.hasOwn(payload,key)) result[key]=payload[key]
        return result
    }
    switch(publicType){
        case Events.BOT_STATUS_CHANGED:
            return {
                previousStatus: stringOrNull(payload.previousStatus),
                status: requiredString(payload.status, "status")
            }

        case Events.BOT_POSITION_CHANGED:
            return {
                previousPosition: stringOrNull(
                    payload.previousPositionStatus ?? payload.previousStatus ??
                    payload.oldStatus ??
                    payload.previousPosition
                ),
                position: requiredString(
                    payload.newStatus ??
                    payload.status ??
                    payload.position,
                    "position"
                )
            }

        case Events.BOT_BALANCE_CHANGED:
            return {
                previousBalance: finiteOrNull(
                    payload.previousBalance ??
                    payload.oldBalance
                ),
                balance: requiredNumber(
                    payload.balance ??
                    payload.newBalance,
                    "balance"
                )
            }

        case Events.BOT_CHAT_MESSAGE:
            return {
                text: requiredString(payload.text, "text"),
                sender: stringOrNull(payload.sender),
                kind: stringOrNull(payload.kind ?? "chat")
            }

        case Events.BOT_KICKED:
            return {
                reason: stringOrNull(payload.reason),
                rawReason: payload.rawReason ?? null
            }

        case Events.BOT_DISCONNECTED:
            return {
                reason: payload.reason ?? null
            }

        case Events.BOT_ERROR:
            return {
                error: requiredString(
                    payload.error ?? "Unknown bot error",
                    "error"
                ),
                stack: stringOrNull(payload.stack)
            }

        case Events.BOT_FATAL:
            return {
                reason: requiredString(
                    payload.reason ?? "fatal_error",
                    "reason"
                ),
                error: stringOrNull(payload.error),
                stack: stringOrNull(payload.stack)
            }

        case Events.BOT_CAPTCHA_DETECTED:
            return {detected: true}

        case Events.BOT_CAPTCHA_ERROR:
            return {error: stringOrNull(payload.error)}

        case Events.BOT_AFK_DETECTED:
            return {
                message: stringOrNull(
                    payload.message ??
                    payload.text
                )
            }

        case Events.TASK_STATE_CHANGED:
            return {
                taskType: "reseller",
                previousState: stringOrNull(
                    payload.oldState ??
                    payload.previousState
                ),
                state: requiredString(payload.state, "state"),
                reason: stringOrNull(payload.reason)
            }

        case Events.TASK_ERROR:
            return {
                taskType: "reseller",
                stage: stringOrNull(payload.stage),
                error: requiredString(payload.error, "error")
            }

        case Events.RESELLER_PURCHASE_COMPLETED:
            return {
                itemId: payload.itemId ?? null,
                amount: requiredNumber(
                    payload.count ??
                    payload.amount,
                    "amount"
                ),
                totalPrice: requiredNumber(
                    payload.totalPrice,
                    "totalPrice"
                ),
                pricePerItem: requiredNumber(
                    payload.pricePerOne ??
                    payload.pricePerItem,
                    "pricePerItem"
                )
            }

        case Events.RESELLER_LISTING_CREATED:{
            const price = requiredNumber(
                payload.price ??
                payload.totalPrice,
                "price"
            )

            return {
                itemId: payload.itemId ?? null,
                amount: finiteOrDefault(
                    payload.count ??
                    payload.amount,
                    1
                ),
                totalPrice: price,
                pricePerItem: finiteOrDefault(
                    payload.pricePerOne ??
                    payload.pricePerItem,
                    price
                )
            }
        }

        case Events.RESELLER_RELIST_COMPLETED:
            return {
                itemId: payload.itemId ?? null,
                targetCount: finiteOrNull(payload.targetCount)
            }

        case Events.RESELLER_WAITING_FOR_SALE:
        case Events.RESELLER_OUT_OF_FUNDS:
            return {
                itemId: payload.itemId ?? null,
                balance: finiteOrNull(payload.balance),
                storageTargetCount: finiteOrNull(
                    payload.storageTargetCount
                )
            }

        case Events.RESELLER_STORAGE_CHANGED:
            return {
                full: localType === "bot:auctionStorageFull"
            }

        default:
            throw new Error(
                `No worker event normalizer for ${localType} -> ${publicType}`
            )
    }
}

function requiredString(value, field){
    if(typeof value !== "string" || !value){
        throw new TypeError(`Missing or invalid "${field}"`)
    }

    return value
}

function requiredNumber(value, field){
    const number = Number(value)

    if(!Number.isFinite(number)){
        throw new TypeError(`Missing or invalid "${field}"`)
    }

    return number
}

function finiteOrNull(value){
    if(value === null || value === undefined){
        return null
    }

    const number = Number(value)

    return Number.isFinite(number) ? number : null
}

function finiteOrDefault(value, fallback){
    const number = Number(value)

    return Number.isFinite(number) ? number : fallback
}

function stringOrNull(value){
    if(value === null || value === undefined){
        return null
    }

    return typeof value === "string" ? value : String(value)
}
