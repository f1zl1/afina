import { Events } from "./events.js"

const contracts = new Map([
    ['bot.runtime.ready',{required:{botId:'number'},optional:{}}],
    ['bot.runtime.incident',{
        required:{type:'string',timestamp:'number'},
        optional:{botId:'number',accountId:'nullableNumber',source:'string',rawMessage:'string',banId:'number',
            banDetectedAt:'number',banIssuedAt:'nullableNumber',banIssuedAtRaw:'nullableString',banReason:'nullableString',
            banDurationRaw:'nullableString',banExpiresAt:'nullableNumber',punishmentId:'nullableString',
            correlated:'boolean',operation:'any',affectedSlots:'any',itemSummaries:'any',previousRole:'nullableString',previousAssignment:'any'}
    }],
    ['core.account.incident',{
        required:{type:'string',botId:'number',bannedAccountId:'number',replacementAccountId:'nullableNumber',generationRequestId:'string',cause:'string',timestamp:'number'},
        optional:{desiredRole:'string',itemId:'nullableNumber',failureReason:'string',requiredReplacementCount:'number',
            availableEligibleAccounts:'number',pendingAccountCreations:'number',generationAllowed:'boolean'}
    }],
    [Events.BOT_STATUS_CHANGED, {
        required: {status: "string"},
        optional: {previousStatus: "nullableString"}
    }],
    [Events.BOT_SUPERVISOR_STATUS_CHANGED, {
        required: {status: "string"},
        optional: {previousStatus: "nullableString"}
    }],
    [Events.BOT_DESIRED_STATE_CHANGED, {
        required: {desiredState: "string"},
        optional: {previousDesiredState: "nullableString"}
    }],
    [Events.BOT_POSITION_CHANGED, {
        required: {position: "string"},
        optional: {previousPosition: "nullableString"}
    }],
    [Events.BOT_BALANCE_CHANGED, {
        required: {balance: "number"},
        optional: {previousBalance: "nullableNumber"}
    }],
    [Events.BOT_CHAT_MESSAGE, {
        required: {text: "string"},
        optional: {
            sender: "nullableString",
            kind: "nullableString"
        }
    }],
    [Events.BOT_KICKED, {
        required: {},
        optional: {
            reason: "nullableString",
            rawReason: "any"
        }
    }],
    [Events.BOT_DISCONNECTED, {
        required: {},
        optional: {reason: "any"}
    }],
    [Events.BOT_ERROR, {
        required: {error: "string"},
        optional: {stack: "nullableString"}
    }],
    [Events.BOT_FATAL, {
        required: {reason: "string"},
        optional: {
            error: "nullableString",
            stack: "nullableString"
        }
    }],
    [Events.BOT_CAPTCHA_DETECTED, {
        required: {},
        optional: {detected: "boolean"}
    }],
    [Events.BOT_CAPTCHA_ERROR, {
        required: {},
        optional: {error: "nullableString"}
    }],
    [Events.BOT_AFK_DETECTED, {
        required: {},
        optional: {message: "nullableString"}
    }],
    [Events.TASK_STATE_CHANGED, {
        required: {
            taskType: "string",
            state: "string"
        },
        optional: {
            previousState: "nullableString",
            reason: "nullableString"
        }
    }],
    [Events.TASK_ERROR, {
        required: {
            taskType: "string",
            error: "string"
        },
        optional: {stage: "nullableString"}
    }],
    [Events.RESELLER_PURCHASE_COMPLETED, {
        required: {
            itemId: "any",
            amount: "number",
            totalPrice: "number",
            pricePerItem: "number"
        },
        optional: {}
    }],
    [Events.RESELLER_LISTING_CREATED, {
        required: {
            itemId: "any",
            amount: "number",
            totalPrice: "number",
            pricePerItem: "number"
        },
        optional: {}
    }],
    [Events.RESELLER_RELIST_COMPLETED, {
        required: {},
        optional: {
            itemId: "any",
            targetCount: "nullableNumber"
        }
    }],
    [Events.RESELLER_WAITING_FOR_SALE, {
        required: {},
        optional: {
            itemId: "any",
            balance: "nullableNumber",
            storageTargetCount: "nullableNumber"
        }
    }],
    [Events.RESELLER_OUT_OF_FUNDS, {
        required: {},
        optional: {
            itemId: "any",
            balance: "nullableNumber",
            storageTargetCount: "nullableNumber"
        }
    }],
    [Events.RESELLER_STORAGE_CHANGED, {
        required: {full: "boolean"},
        optional: {}
    }],
    [Events.WORKER_STARTED, {
        required: {
            workerPid: "number",
            startedAt: "number"
        },
        optional: {}
    }],
    [Events.WORKER_EXITED, {
        required: {reason: "string"},
        optional: {
            code: "nullableNumber",
            signal: "nullableString",
            context: "any",
            desiredState: "nullableString"
        }
    }],
    [Events.WORKER_UNRESPONSIVE, {
        required: {elapsed: "number"},
        optional: {
            workerPid: "nullableNumber",
            lastHeartbeatAt: "nullableNumber"
        }
    }],
    [Events.RECONNECT_SCHEDULED, {
        required: {
            attempt: "number",
            delay: "number"
        },
        optional: {lastReason: "nullableString"}
    }],
    [Events.RECONNECT_EXHAUSTED, {
        required: {
            crashes: "number",
            windowMs: "number"
        },
        optional: {lastReason: "nullableString"}
    }]
])

export function hasEventContract(type){
    return contracts.has(type)
}

export function validateEventPayload(type, payload){
    const contract = contracts.get(type)
    if(!contract) return []

    if(!payload || typeof payload !== "object" || Array.isArray(payload)){
        return ["payload must be an object"]
    }

    const errors = []

    for(const [key, expectedType] of Object.entries(contract.required)){
        if(!(key in payload)){
            errors.push(`missing required field "${key}"`)
            continue
        }

        if(!matchesType(payload[key], expectedType)){
            errors.push(`field "${key}" must be ${expectedType}`)
        }
    }

    for(const [key, value] of Object.entries(payload)){
        const expectedType = contract.required[key] ?? contract.optional[key]

        if(!expectedType){
            errors.push(`unknown field "${key}"`)
            continue
        }

        if(!matchesType(value, expectedType)){
            errors.push(`field "${key}" must be ${expectedType}`)
        }
    }

    return errors
}

function matchesType(value, expectedType){
    if(expectedType === "any") return true

    if(expectedType === "nullableString"){
        return value === null || typeof value === "string"
    }

    if(expectedType === "nullableNumber"){
        return value === null || (
            typeof value === "number" &&
            Number.isFinite(value)
        )
    }

    if(expectedType === "string"){
        return typeof value === "string"
    }

    if(expectedType === "number"){
        return typeof value === "number" && Number.isFinite(value)
    }

    if(expectedType === "boolean"){
        return typeof value === "boolean"
    }

    if(expectedType === "object"){
        return Boolean(
            value &&
            typeof value === "object" &&
            !Array.isArray(value)
        )
    }

    return false
}
