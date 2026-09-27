import { Events } from "../events/events.js"

export default class BotSnapshotStore{
    constructor({
        eventBus,
        logger
    }){
        this.eventBus = eventBus
        this.logger = logger.child("BotSnapshotStore")
        this.snapshots = new Map()

        this.onEvent = this.#onEvent.bind(this)
        this.eventBus.onAny(this.onEvent)

        this.logger.info("BotSnapshotStore started")
    }

    registerBot({
        botId,
        accountId,
        taskData = null,
        serverData = null
    }){
        if(this.snapshots.has(botId)){
            return this.get(botId)
        }

        const snapshot = this.#createSnapshot({
            botId,
            accountId
        })

        snapshot.task = this.#createTaskSnapshot(taskData)

        snapshot.server = serverData
            ? {
                serverId: serverData.serverId ?? null,
                version: serverData.version ?? null
            }
            : null

        this.snapshots.set(botId, snapshot)

        return this.get(botId)
    }

    updateConfiguration(botId, {accountData, taskData, serverData}){
        const snapshot = this.snapshots.get(botId)
        if(!snapshot) return
        if(snapshot.accountId!==accountData?.accountId)snapshot.incident=null
        snapshot.accountId = accountData?.accountId ?? null
        snapshot.task = this.#createTaskSnapshot(taskData)
        snapshot.server = serverData ? {serverId: serverData.serverId, version: serverData.version} : null
    }

    get(botId){
        const snapshot = this.snapshots.get(botId)

        return snapshot
            ? structuredClone(snapshot)
            : null
    }

    getAll(){
        return [...this.snapshots.values()].map(
            snapshot => structuredClone(snapshot)
        )
    }

    has(botId){
        return this.snapshots.has(botId)
    }

    remove(botId){
        return this.snapshots.delete(botId)
    }

    destroy(){
        this.eventBus.offAny(this.onEvent)
        this.snapshots.clear()
    }

    #onEvent(event){
        if(this.workerEventIsCurrent&& !this.workerEventIsCurrent(event))return
        const botId =
            event.source?.botId ??
            event.payload?.botId

        if(botId === null || botId === undefined){
            return
        }

        const snapshot = this.#getOrCreate(
            botId,
            event.source?.accountId ?? null
        )
        if(event.source?.incarnationId)snapshot.incarnationId=event.source.incarnationId

        switch(event.type){
            case 'bot.runtime.incident':
                snapshot.incident=event.payload
                break
            case Events.BOT_STATUS_CHANGED:
                this.#applyRuntimeStatus(snapshot, event)
                break

            case Events.BOT_SUPERVISOR_STATUS_CHANGED:
                snapshot.supervisor.status = event.payload.status
                snapshot.supervisor.previousStatus =
                    event.payload.previousStatus ?? null
                snapshot.supervisor.statusChangedAt = event.timestamp
                break

            case Events.BOT_DESIRED_STATE_CHANGED:
                snapshot.desiredState = event.payload.desiredState
                break

            case Events.BOT_POSITION_CHANGED:
                snapshot.runtime.previousPosition =
                    event.payload.previousPosition ?? null
                snapshot.runtime.position = event.payload.position
                break

            case Events.BOT_BALANCE_CHANGED:
                snapshot.runtime.balance = event.payload.balance
                break

            case Events.BOT_KICKED:
                snapshot.connection.lastKickReason =
                    event.payload.reason ?? null
                break

            case Events.BOT_DISCONNECTED:
                snapshot.connection.connected = false
                snapshot.connection.lastDisconnectReason =
                    event.payload.reason ?? null
                break

            case Events.BOT_ERROR:
                snapshot.lastError = {
                    message: event.payload.error,
                    stack: event.payload.stack ?? null,
                    at: event.timestamp
                }
                break

            case Events.BOT_FATAL:
                snapshot.lastFatalError = {
                    reason: event.payload.reason,
                    error: event.payload.error ?? null,
                    stack: event.payload.stack ?? null,
                    at: event.timestamp
                }
                break

            case Events.TASK_STATE_CHANGED:
                this.#applyTaskState(snapshot, event)
                break

            case Events.TASK_ERROR:
                this.#applyTaskError(snapshot, event)
                break

            case Events.RESELLER_PURCHASE_COMPLETED:
                this.#applyPurchase(snapshot, event)
                break

            case Events.RESELLER_LISTING_CREATED:
                this.#applyListing(snapshot, event)
                break

            case Events.RESELLER_RELIST_COMPLETED:
                this.#applyRelist(snapshot, event)
                break

            case Events.RESELLER_WAITING_FOR_SALE:
            case Events.RESELLER_OUT_OF_FUNDS:
                this.#applyLiquidity(snapshot, event)
                break

            case Events.RESELLER_STORAGE_CHANGED:
                this.#applyStorageState(snapshot, event)
                break

            case Events.WORKER_STARTED:
                snapshot.incident=null
                snapshot.worker.pid = event.payload.workerPid
                snapshot.worker.startedAt = event.payload.startedAt
                snapshot.worker.ready = true
                snapshot.worker.healthy = true
                break

            case Events.WORKER_EXITED:
                snapshot.worker.pid = null
                snapshot.worker.ready = false
                snapshot.worker.healthy = false
                snapshot.worker.lastExitReason = event.payload.reason
                snapshot.worker.lastExitAt = event.timestamp
                snapshot.runtime.status = "offline"
                snapshot.connection.connected = false
                break

            case Events.WORKER_UNRESPONSIVE:
                snapshot.worker.healthy = false
                break

            case Events.RECONNECT_SCHEDULED:
                snapshot.reconnect.attempts = event.payload.attempt
                snapshot.reconnect.scheduled = true
                snapshot.reconnect.blocked = false
                snapshot.reconnect.delay = event.payload.delay
                snapshot.reconnect.lastReason =
                    event.payload.lastReason ?? null
                break

            case Events.RECONNECT_EXHAUSTED:
                snapshot.reconnect.blocked = true
                snapshot.reconnect.scheduled = false
                snapshot.reconnect.delay = null
                snapshot.reconnect.lastReason =
                    event.payload.lastReason ?? null
                break
        }

        snapshot.accountId =
            event.source?.accountId ??
            snapshot.accountId

        snapshot.updatedAt = event.timestamp
        snapshot.lastEventId = event.id
    }

    #applyRuntimeStatus(snapshot, event){
        snapshot.runtime.previousStatus =
            event.payload.previousStatus ?? null
        snapshot.runtime.status = event.payload.status
        snapshot.runtime.statusChangedAt = event.timestamp

        if(event.payload.status === "running"){
            snapshot.connection.connected = true
        }
    }

    #applyTaskState(snapshot, event){
        const task = this.#ensureTask(snapshot)

        task.type = event.payload.taskType
        task.previousState = event.payload.previousState
        task.state = event.payload.state
        task.stateReason = event.payload.reason
        task.stateChangedAt = event.timestamp
    }

    #applyTaskError(snapshot, event){
        const task = this.#ensureTask(snapshot)

        task.lastError = {
            stage: event.payload.stage ?? null,
            error: event.payload.error,
            at: event.timestamp
        }
    }

    #applyPurchase(snapshot, event){
        const task = this.#ensureTask(snapshot)

        task.lastPurchase = {
            itemId: event.payload.itemId,
            amount: event.payload.amount,
            totalPrice: event.payload.totalPrice,
            pricePerItem: event.payload.pricePerItem,
            at: event.timestamp
        }

        task.metrics.purchases++
        task.metrics.purchasedItems += event.payload.amount
        task.metrics.spent += event.payload.totalPrice
    }

    #applyListing(snapshot, event){
        const task = this.#ensureTask(snapshot)

        task.lastListing = {
            itemId: event.payload.itemId,
            amount: event.payload.amount,
            totalPrice: event.payload.totalPrice,
            pricePerItem: event.payload.pricePerItem,
            at: event.timestamp
        }

        task.metrics.listings++
        task.metrics.listedItems += event.payload.amount
        task.metrics.listedValue += event.payload.totalPrice
    }

    #applyRelist(snapshot, event){
        const task = this.#ensureTask(snapshot)

        task.lastRelist = {
            itemId: event.payload.itemId ?? null,
            targetCount: event.payload.targetCount ?? null,
            at: event.timestamp
        }

        task.metrics.relists++
    }

    #applyLiquidity(snapshot, event){
        const task = this.#ensureTask(snapshot)

        task.liquidity = {
            balance: event.payload.balance ?? null,
            storageTargetCount:
                event.payload.storageTargetCount ?? null,
            updatedAt: event.timestamp
        }
    }

    #applyStorageState(snapshot, event){
        const task = this.#ensureTask(snapshot)

        task.storage.full = event.payload.full
        task.storage.updatedAt = event.timestamp
    }

    #ensureTask(snapshot){
        if(!snapshot.task){
            snapshot.task = this.#createTaskSnapshot()
        }

        return snapshot.task
    }

    #getOrCreate(botId, accountId){
        let snapshot = this.snapshots.get(botId)

        if(snapshot){
            return snapshot
        }

        snapshot = this.#createSnapshot({
            botId,
            accountId
        })

        this.snapshots.set(botId, snapshot)

        return snapshot
    }

    #createSnapshot({
        botId,
        accountId
    }){
        return {
            version: 2,
            botId,
            accountId,

            desiredState: "stopped",

            supervisor: {
                status: "offline",
                previousStatus: null,
                statusChangedAt: null
            },

            runtime: {
                status: "offline",
                previousStatus: null,
                statusChangedAt: null,
                position: null,
                previousPosition: null,
                balance: null
            },

            task: null,
            server: null,

            connection: {
                connected: false,
                lastKickReason: null,
                lastDisconnectReason: null
            },

            worker: {
                pid: null,
                startedAt: null,
                ready: false,
                healthy: false,
                lastExitReason: null,
                lastExitAt: null
            },

            reconnect: {
                attempts: 0,
                scheduled: false,
                blocked: false,
                delay: null,
                lastReason: null
            },

            lastError: null,
            lastFatalError: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            lastEventId: null
        }
    }

    #createTaskSnapshot(taskData = null){
        return {
            taskId: taskData?.taskId ?? null,
            type: taskData?.type ?? null,
            itemId:
                taskData?.itemId ??
                taskData?.item?.itemId ??
                null,

            previousState: null,
            state: null,
            stateReason: null,
            stateChangedAt: null,

            storage: {
                full: null,
                updatedAt: null
            },

            liquidity: {
                balance: null,
                storageTargetCount: null,
                updatedAt: null
            },

            lastPurchase: null,
            lastListing: null,
            lastRelist: null,
            lastError: null,

            metrics: {
                purchases: 0,
                purchasedItems: 0,
                spent: 0,
                listings: 0,
                listedItems: 0,
                listedValue: 0,
                relists: 0
            }
        }
    }
}
