import BotProcess from "./botProcess.js"
import { Events } from "../events/events.js"
import IncidentStore from '../incidents/incidentStore.js'
import {WorkerPublicEventMap} from '../events/events.js'
import {setMaxListeners} from 'node:events'
const workerEvents=new Set([...Object.values(WorkerPublicEventMap),Events.WORKER_STARTED,Events.WORKER_EXITED])

export default class BotManager{
    constructor({
        logger,
        eventBus,
        accountManager,
        dataBaseManager,
        imageSolver,
        snapshotStore
    }){
        this.rootLogger = logger
        this.logger = logger.child("BotManager")
        this.eventBus = eventBus
        this.accountManager = accountManager
        this.dataBaseManager = dataBaseManager
        this.imageSolver = imageSolver
        this.snapshotStore = snapshotStore
        this.incidentStore=new IncidentStore(dataBaseManager?.store)
        this.definitions = new Map()
        this.bots = new Map()
        if(snapshotStore)snapshotStore.workerEventIsCurrent=event=>this.isCurrentWorkerEvent(event)

        this.reconnectBaseDelayMs = 1000
        this.reconnectMaxDelayMs = 30_000
        this.reconnectJitterMs = 500
        this.stableConnectionMs = 60_000

        this.crashWindowMs = 5 * 60_000
        this.maxCrashesInWindow = 8

        this.heartbeatCheckIntervalMs = 5000
        this.heartbeatTimeoutMs = 20_000

        this.heartbeatTimer = setInterval(() => {
            this.#checkHeartbeats()
        }, this.heartbeatCheckIntervalMs)

        this.logger.info("BotManager started")
    }

    installLifecycle(lifecycle){this.lifecycle=lifecycle;for(const bot of this.bots.values()){this.#clearReconnectTimer(bot);this.#clearStableTimer(bot)}}
    cancelLifecycleMechanics(botId){const bot=this.getBot(botId);if(!bot)return;this.#clearReconnectTimer(bot);this.#clearStableTimer(bot);bot.restartRequested=false;bot.cancelQuiescence?.('STOP_SUPERSEDED');bot.cancelStopWait?.()}
    closeLifecycleAdmission(){this.closing=true;clearInterval(this.heartbeatTimer);this.configurationService?.destroy();for(const bot of this.bots.values())this.cancelLifecycleMechanics(bot.botId)}
    async stopOwned(botId,{actionId,valid,force=false,deadlineAt,quiesceDeadlineAt=deadlineAt}){
        const action=this.lifecycle.authorize(botId,actionId,'stop')
        if(force&&!(action.metadata.manual&&action.metadata.force))throw new Error('FORCED_STOP_NOT_AUTHORIZED')
        const bot=this.getBot(botId);if(!bot?.isRunning())return
        const incarnation=bot.incarnationId
        const check=()=>valid()&&this.lifecycle.valid(actionId)&&this.getBot(botId)===bot&&bot.incarnationId===incarnation
        this.#clearReconnectTimer(bot);this.#clearStableTimer(bot);bot.restartRequested=false
        this.#setDesiredState(bot,'stopped');this.#setSupervisorStatus(bot,'quiescing')
        if(!force)await bot.requestQuiescence({actionId,deadlineAt:quiesceDeadlineAt,valid:check,onProgress:e=>this.lifecycle.evidence(actionId,e)})
        if(!bot.isRunning())return
        if(!check())throw new Error('STALE_REVISION')
        this.#setSupervisorStatus(bot,'stopping')
        await new Promise((resolve,reject)=>{
            const finish=error=>{clearTimeout(timer);bot.off('exit',exit);bot.cancelStopWait=null;error?reject(new Error(error)):resolve()}
            const exit=()=>finish()
            const timer=setTimeout(()=>finish('PROCESS_STOP_TIMEOUT'),Math.max(1,deadlineAt-Date.now()))
            bot.cancelStopWait=()=>finish('STOP_SUPERSEDED')
            bot.once('exit',exit)
            if(force)bot.kill('manual_force_stop');else bot.stop('graceful_stop',{escalate:false})
        })
    }
    async shutdown(){
        this.closeLifecycleAdmission()
        await Promise.allSettled([...this.bots.values()].map(async bot=>{
            if(!bot.isRunning())return
            const incarnation=bot.incarnationId,deadlineAt=Date.now()+5000
            try{
                await bot.requestQuiescence({actionId:'shutdown:'+incarnation,deadlineAt,valid:()=>bot.incarnationId===incarnation})
                if(bot.incarnationId===incarnation&&bot.isRunning())await new Promise(resolve=>{
                    const exit=()=>{clearTimeout(timer);bot.off('exit',exit);resolve()}
                    const timer=setTimeout(exit,Math.max(1,deadlineAt-Date.now()))
                    bot.once('exit',exit);bot.stop('application_shutdown',{escalate:false})
                })
            }catch{}
            if(bot.incarnationId===incarnation&&bot.isRunning())bot.kill('application_shutdown')
        }))
    }

    async loadBots(){
        const rows = await this.dataBaseManager.getAllBotsData()

        this.definitions.clear()

        for(const row of rows){
            this.definitions.set(row.botId, this.#normalizeDefinition(row))

            this.snapshotStore?.registerBot({
                botId: row.botId,
                accountId: row.connectedAccountId ?? null,
                taskData: null,
                serverData: null
            })
        }

        this.logger.info("Bot definitions loaded", {
            bots: this.definitions.size
        })

        return this.getBotDefinitions()
    }

    async synchronizeDefinitions(){
        const rows = await this.dataBaseManager.getAllBotsData()
        const ids = new Set(rows.map(row => Number(row.botId)))
        for(const id of this.definitions.keys()){
            if(ids.has(id)) continue
            this.removeBot(id)
            this.definitions.delete(id)
            this.snapshotStore?.remove(id)
        }
        for(const row of rows){
            const definition = this.#normalizeDefinition(row)
            this.definitions.set(definition.botId, definition)
            this.snapshotStore?.registerBot({botId: definition.botId, accountId: definition.connectedAccountId})
        }
    }

    async createBotDefinition({
        name = null,
        type = "test",
        connectedAccountId = null,
        serverId = null,
        realm = null
    } = {}){
        if(connectedAccountId !== null){
            const accountData = await this.dataBaseManager.getAccountData(connectedAccountId)

            if(!accountData){
                throw new Error(`Account ${connectedAccountId} not found`)
            }
        }

        const row = await this.dataBaseManager.createBotData({
            name,
            type,
            connectedAccountId,
            serverId,
            realm
        })

        const definition = this.#normalizeDefinition(row)
        this.definitions.set(definition.botId, definition)

        this.snapshotStore?.registerBot({
            botId: definition.botId,
            accountId: definition.connectedAccountId,
            taskData: null,
            serverData: null
        })

        this.logger.info("Bot definition created", {
            botId: definition.botId,
            accountId: definition.connectedAccountId,
            type: definition.type
        })

        return structuredClone(definition)
    }

    async archiveBot(botId){
        const definition = this.getBotDefinition(botId)
        if(!definition) return false

        if(this.lifecycle&&this.getBot(botId)?.isRunning())throw new Error('BOT_MUST_BE_STOPPED_BEFORE_ARCHIVE')
        if(this.lifecycle)this.lifecycle.safetyStop(botId,'BOT_ARCHIVED')

        const bot = this.getBot(botId)

        if(bot){
            this.#setDesiredState(bot, "stopped")
            bot.restartRequested = false
            this.#clearReconnectTimer(bot)
            this.#clearStableTimer(bot)

            if(bot.isRunning()){
                bot.stop("bot_archived")
            }

            this.bots.delete(botId)
        }

        const archived = await this.dataBaseManager.archiveBotData(botId)
        if(!archived) return false

        this.definitions.delete(botId)
        this.snapshotStore?.remove(botId)

        this.logger.info("Bot archived", {
            botId,
            accountId: definition.connectedAccountId
        })

        return true
    }

    getBotDefinition(botId){
        const definition = this.definitions.get(Number(botId))
        return definition ? structuredClone(definition) : null
    }

    getBotDefinitions(){
        return [...this.definitions.values()].map(definition => structuredClone(definition))
    }

    updateBotDefinitionAccount(botId, accountId){
        botId = Number(botId)

        const definition = this.definitions.get(botId)

        if(!definition){
            throw new Error(`Bot ${botId} not found`)
        }

        definition.connectedAccountId =
            accountId === null || accountId === undefined
                ? null
                : Number(accountId)

        definition.updatedAt = new Date().toISOString()

        return structuredClone(definition)
    }

    discardBotProcess(botId){
        botId = Number(botId)

        const bot = this.bots.get(botId)
        if(!bot) return false

        if(bot.isRunning()){
            throw new Error(`Cannot discard running bot process ${botId}`)
        }

        this.#clearReconnectTimer(bot)
        this.#clearStableTimer(bot)
        this.bots.delete(botId)

        this.logger.info("Bot process discarded", {
            botId,
            accountId: bot.accountId
        })

        return true
    }

    getBot(botId){
        return this.bots.get(Number(botId))
    }

    getBots(){
        return [...this.bots.values()]
    }

    hasBot(botId){
        return this.definitions.has(Number(botId))
    }

    getBotRuntimeState(botId){
        const definition = this.definitions.get(Number(botId))
        if(!definition) return null

        const bot = this.getBot(botId)
        const account=this.dataBaseManager?.store?.prepare('SELECT a.banned,h.* FROM accountsData a LEFT JOIN accountBanHistory h ON h.id=a.currentBanId WHERE a.accountId=?').get(definition.connectedAccountId)
        const incident=bot?.operationalBlock ?? (account?.banned?{type:'ACCOUNT_BANNED',banReason:account.reason,banDetectedAt:account.detectedAt,banIssuedAtRaw:account.issuedAtRaw,banDurationRaw:account.durationRaw,banExpiresAt:account.expiresAt,punishmentId:account.punishmentId,rawMessage:account.rawMessage}:null)

        if(bot){
            return {...bot.getRuntimeState(),observation:this.getWorkerObservation(botId),incident, configuration: this.configurationService?.status(Number(botId)) ?? null}
        }

        return {
            botId: definition.botId,
            incident,
            accountId: definition.connectedAccountId,
            desiredState: "stopped",
            supervisorStatus: "offline",
            runtimeStatus: "offline",
            configuration: this.configurationService?.status(Number(botId)) ?? null,
            running: false,
            workerPid: null
        }
    }

    getBotsRuntimeState(){
        return this.getBotDefinitions().map(definition => {
            return this.getBotRuntimeState(definition.botId)
        })
    }

    async startBot(botId,executionGuard=null,actionId=null){
        botId = Number(botId)
        if(this.closing)throw new Error('APPLICATION_STOPPING')
        this.lifecycle?.authorize(botId,actionId,'start')

        if(!this.hasBot(botId)){
            throw new Error(`Bot ${botId} not found`)
        }

        let bot = this.getBot(botId)

        if(!bot){
            bot = await this.#prepareBot(botId)
        }

        executionGuard?.()
        this.#setDesiredState(bot, "running")
        bot.restartRequested = false

        this.#clearReconnectTimer(bot)

        if(bot.reconnectBlocked){
            this.#resetCrashProtection(bot)
        }

        if(bot.isRunning()) return bot

        await this.#startBotProcess(bot,executionGuard,actionId)

        return bot
    }

    stopBot(botId,{safety=false,reason='safety_stop'}={}){
        botId = Number(botId)
        if(this.lifecycle){
            if(!safety)throw new Error('LIFECYCLE_OWNERSHIP_REQUIRED')
            this.lifecycle.safetyStop(botId,reason)
        }

        if(!this.hasBot(botId)){
            throw new Error(`Bot ${botId} not found`)
        }

        const bot = this.getBot(botId)

        if(!bot) return false

        this.#setDesiredState(bot, "stopped")
        bot.restartRequested = false

        this.#clearReconnectTimer(bot)
        this.#clearStableTimer(bot)

        if(!bot.isRunning()){
            this.#setSupervisorStatus(bot, "stopped")
            return true
        }

        this.#setSupervisorStatus(bot, "stopping")
        bot.stop("manual_stop")
        return true
    }

    async restartBot(botId,{reason='unexpected_stop',incarnationId=null}={}){
        botId = Number(botId)
        if(this.closing)return false
        if(this.lifecycle)return this.lifecycle.request(botId,reason,incarnationId??this.getBot(botId)?.incarnationId??null)

        if(!this.hasBot(botId)){
            throw new Error(`Bot ${botId} not found`)
        }

        let bot = this.getBot(botId)

        if(!bot){
            return this.startBot(botId)
        }

        this.#setDesiredState(bot, "running")
        bot.restartRequested = true

        this.#clearReconnectTimer(bot)
        this.#clearStableTimer(bot)
        this.#resetCrashProtection(bot)

        if(!bot.isRunning()){
            bot.restartRequested = false
            this.#startBotProcess(bot)
            return bot
        }

        this.#setSupervisorStatus(bot, "stopping")
        bot.stop("manual_restart")
        return bot
    }

    removeBot(botId){
        const bot = this.getBot(botId)
        if(!bot) return false
        if(this.lifecycle&&bot.isRunning())throw new Error('BOT_MUST_BE_STOPPED_BEFORE_REMOVE')

        this.#setDesiredState(bot, "stopped")
        bot.restartRequested = false

        this.#clearReconnectTimer(bot)
        this.#clearStableTimer(bot)

        bot.stop("manual_stop")
        this.bots.delete(botId)

        this.#loggerFor(bot).info("Bot process removed")
        return true
    }

    broadcastEvent(event, context = {}){
        for(const bot of this.bots.values()){
            if(!bot.isRunning()) continue
            bot.sendEvent(event, context)
        }
    }

    sendEvent(botId, event, context = {}){
        const bot = this.getBot(botId)
        if(!bot || !bot.isRunning()) return false
        return bot.sendEvent(event, context)
    }

    async #prepareBot(botId){
        const payload = this.dataBaseManager.getConfigurationSnapshot().configurations.get(botId)
        if(!payload || payload.error) throw new Error(payload?.error ?? `Bot ${botId} not found`)
        if(!payload.accountData || !payload.serverData) throw new Error("Configure the bot account and server first")
        if(!Number.isInteger(payload.definition.realm)) throw new Error("Configure the bot realm first")
        return this.#createBotProcess({botId,...structuredClone(payload)})
    }

    #createBotProcess({
        botId,
        accountData,
        taskData,
        serverData,
        settings
    }){
        if(this.bots.has(botId)){
            throw new Error(`Bot process ${botId} already exists`)
        }

        const bot = new BotProcess({
            botId,
            accountData,
            taskData,
            serverData,
            resellerSettings: settings,
            logger: this.rootLogger,
            eventBus: this.eventBus,
            imageSolver: this.imageSolver
        })

        bot.on("ready", data => {
            this.#onBotProcessReady(bot, data)
        })

        bot.on("exit", data => {
            this.#onBotProcessExit(bot, data)
        })

        bot.on("workerEvent", data => {
            this.#onWorkerEvent(bot, data)
        })
        bot.beforePublicEvent=event=>this.handleRuntimeIncident(bot,event)

        this.bots.set(botId, bot)

        this.snapshotStore?.registerBot({
            botId,
            accountId: accountData.accountId,
            taskData,
            serverData
        })

        this.#loggerFor(bot).info("Bot process prepared")

        return bot
    }

    async #startBotProcess(bot,executionGuard=null,actionId=null){
        if(this.closing)return
        this.lifecycle?.authorize(bot.botId,actionId,'start')
        if(bot.desiredState !== "running") return
        if(bot.reconnectBlocked) return
        if(bot.isRunning()) return
        if(bot.startingConfiguration) return
        bot.startingConfiguration = true

        this.#setSupervisorStatus(bot, "starting")

        try{
            await this.configurationService?.prepare(bot)
            const account=this.dataBaseManager?.store?.prepare('SELECT banned,disabled FROM accountsData WHERE accountId=?').get(bot.accountId)
            if(account?.banned || account?.disabled){
                this.#setDesiredState(bot,'stopped');this.#setSupervisorStatus(bot,'blocked');bot.reconnectBlocked=true;return
            }
            if(bot.desiredState !== "running" || this.bots.get(bot.botId) !== bot) return
            executionGuard?.()
            if(this.closing)throw new Error('APPLICATION_STOPPING')
            bot.start({beforeSpawn:incarnation=>this.lifecycle?.beforeSpawn(bot.botId,actionId,incarnation),proxyLifecycle:this.lifecycle?.core.proxies})
        }catch(error){
            if(executionGuard){
                // A cancelled autonomous launch must never enter the reconnect loop.
                this.#setDesiredState(bot,"stopped")
                this.#setSupervisorStatus(bot,"stopped")
                throw error
            }
            this.#loggerFor(bot).error("Failed to start worker", {
                error: error?.message ?? String(error),
                stack: error?.stack ?? null
            })

            bot.lastExitReason = "startup_error"
            bot.lastExitAt = Date.now()

            if(this.#registerCrash(bot, "startup_error")) return
            this.#scheduleReconnect(bot)
        }finally{
            bot.startingConfiguration = false
        }
    }

    #onBotProcessReady(bot, {
        workerPid,
        startedAt
    }){
        if(this.bots.get(bot.botId) !== bot) return

        this.configurationService?.applied(bot)

        this.eventBus.publish(
            Events.WORKER_STARTED,
            {
                workerPid,
                startedAt
            },
            this.#botSource(bot)
        )
    }

    #onBotProcessExit(bot, {
        code,
        signal,
        reason,
        context
    }){
        if(this.bots.get(bot.botId) !== bot) return

        this.#clearStableTimer(bot)

        bot.lastExitReason = reason
        bot.lastExitAt = Date.now()

        this.#loggerFor(bot).warn("Worker exited", {
            code,
            signal,
            reason,
            context,
            desiredState: bot.desiredState
        })

        this.eventBus.publish(
            Events.WORKER_EXITED,
            {
                code,
                signal,
                reason,
                context,
                desiredState: bot.desiredState
            },
            this.#botSource(bot)
        )

        if(this.lifecycle){
            this.lifecycle.exited(bot,{code,signal,reason,context})
            this.#setSupervisorStatus(bot,this.lifecycle.state.get(bot.botId)?.intent==='running'?'recovery_pending':'stopped')
            return
        }
        if(bot.reconnectBlocked){this.#setSupervisorStatus(bot,'blocked');return}
        if(bot.desiredState !== "running"){
            this.#setSupervisorStatus(bot, "stopped")
            return
        }

        if(bot.restartRequested){
            bot.restartRequested = false
            this.#startBotProcess(bot)
            return
        }

        if(this.#registerCrash(bot, reason)) return

        this.#scheduleReconnect(bot)
    }

    #onWorkerEvent(bot, {
        event,
        context
    }){
        if(event !== Events.BOT_STATUS_CHANGED) return
        if(context?.status !== "running") return
        if(bot.reconnectBlocked)return

        this.#setSupervisorStatus(bot, "running")
        this.#clearStableTimer(bot)
        if(this.lifecycle)return

        bot.stableTimer = setTimeout(() => {
            bot.stableTimer = null

            if(!bot.isRunning()) return
            if(bot.runtimeStatus !== "running") return
            if(bot.supervisorStatus !== "running") return

            bot.reconnectAttempts = 0
            bot.crashHistory = []

            this.#loggerFor(bot).info("Connection considered stable")
        }, this.stableConnectionMs)
    }

    isCurrentWorkerEvent(event){
        if(!workerEvents.has(event.type)||event.source?.kind!=='bot')return true
        const bot=this.getBot(event.source.botId)
        return Boolean(bot&&event.source.incarnationId===bot.incarnationId&&(!event.source.workerPid||event.source.workerPid===bot.workerPid))
    }
    getWorkerObservation(botId,options){
        const bot=this.getBot(botId),now=options?.now??Date.now()
        const value=bot?.getWorkerObservation?.(options)??{botId,process:{alive:bot?null:false,ipcConnected:false,pid:null,incarnationId:null,startedAt:null,observedAt:now,source:'process_observation'},quality:bot?'UNAVAILABLE':'PROCESS_MISSING',facts:null,source:'process_observation',reason:bot?'WORKER_OBSERVATION_API_UNAVAILABLE':'PROCESS_MISSING',lastObservedAt:null,lastEventAt:null,lastReceivedAt:null,ageMs:null,intent:{desiredState:bot?.desiredState??'stopped',supervisorStatus:'unknown'}}
        return {...value,configurationStale:this.configurationService?.status(Number(botId))?.restartRequired===true}
    }
    async observeBots(botIds,{force=false,signal,freshMs=15000,timeoutMs=1000,concurrency=32,scanTimeoutMs=3000}={}){
        const startedAt=Date.now(),controller=new AbortController(),abort=()=>controller.abort()
        setMaxListeners(concurrency+2,controller.signal)
        if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true})
        const timer=setTimeout(abort,scanTimeoutMs),stats={queried:0,refreshed:0,timeouts:0,unavailable:0}
        let cursor=0
        // A deadline must not permanently starve workers later in a large inventory.
        const offset=(this.observationCursor??0)%Math.max(1,botIds.length)
        try{
            await Promise.all(Array.from({length:Math.min(concurrency,botIds.length)},async()=>{
                while(cursor<botIds.length&&!controller.signal.aborted){
                    const id=botIds[(offset+cursor++)%botIds.length],before=this.getWorkerObservation(id,{freshMs}),bot=this.getBot(id)
                    if(before.process.alive===false||!bot)continue
                    if(!force&&(before.quality==='FRESH'||Date.now()-(before.lastAttemptAt??0)<1000))continue
                    stats.queried++
                    let result
                    try{result=await bot.requestFacts({timeoutMs,signal:controller.signal})}catch{result={ok:false,reason:'WORKER_FACTS_UNAVAILABLE'}}
                    if(result.ok)stats.refreshed++;else{stats.unavailable++;if(result.reason==='WORKER_FACTS_TIMEOUT')stats.timeouts++}
                }
            }))
        }finally{this.observationCursor=(offset+cursor)%Math.max(1,botIds.length);clearTimeout(timer);signal?.removeEventListener('abort',abort)}
        const stale=botIds.filter(id=>this.getWorkerObservation(id,{freshMs}).quality==='STALE').length
        return {...stats,stale,workers:botIds.length,durationMs:Date.now()-startedAt,deadlineReached:controller.signal.aborted,unqueried:Math.max(0,botIds.length-cursor)}
    }
    cancelObservation(){for(const bot of this.bots.values())bot.cancelFactRequest?.('OBSERVATION_CANCELLED')}

    handleRuntimeIncident(bot,event){
        if(event?.type!=='bot.runtime.incident')return true
        if(this.bots.get(bot.botId)!==bot)return false
        const incident=event.payload
        if(incident.type==='ACCOUNT_BANNED'){
            let result
            try{
                result=this.incidentStore.recordBan(bot.accountId,incident,{botId:bot.botId,role:bot.taskData?.type,
                    itemId:bot.taskData?.itemId,configurationFingerprint:this.configurationService?.states?.get(bot.botId)?.applied?.fingerprint ?? null,
                    startedAt:bot.startedAt ?? null,uptimeMs:bot.startedAt?Date.now()-bot.startedAt:null})
            }catch{
                // A storage failure cannot permit this session to reconnect or claim a persisted ban.
                this.stopBot(bot.botId,{safety:true,reason:'BAN_PERSISTENCE_FAILED'});bot.reconnectBlocked=true
                this.eventBus.publish('bot.runtime.incident',{type:'BAN_PERSISTENCE_FAILED',botId:bot.botId,accountId:bot.accountId,timestamp:Date.now()},{botId:bot.botId})
                return false
            }
            if(!result.created && !result.reactivated)return false
            // Persistence is synchronous and precedes notification, stop, and reconnect decisions.
            event.payload={...incident,accountId:bot.accountId,banId:result.ban.id,previousRole:bot.taskData?.type ?? null,previousAssignment:{itemId:bot.taskData?.itemId ?? null}}
            this.eventBus.publishEnvelope(event)
            this.stopBot(bot.botId,{safety:true,reason:'ACCOUNT_BANNED'});bot.reconnectBlocked=true
            return false
        }
        if(incident.type==='INVENTORY_BLOCKED_BY_IGNORED_ITEMS'){
            bot.operationalBlock=incident
            bot.reconnectBlocked=true
            this.#setSupervisorStatus(bot,'blocked')
        }
        return true
    }

    #registerCrash(bot, reason){
        if(reason === "manual_stop" || reason === "manual_restart" || reason === "bot_archived"){
            return false
        }

        const now = Date.now()

        bot.crashHistory = bot.crashHistory.filter(
            time => now - time <= this.crashWindowMs
        )

        bot.crashHistory.push(now)

        if(bot.crashHistory.length < this.maxCrashesInWindow){
            return false
        }

        bot.reconnectBlocked = true

        this.#clearReconnectTimer(bot)
        this.#setSupervisorStatus(bot, "failed")

        this.#loggerFor(bot).error("Reconnect stopped because of crash loop", {
            crashes: bot.crashHistory.length,
            windowMs: this.crashWindowMs,
            lastReason: reason
        })

        this.eventBus.publish(
            Events.RECONNECT_EXHAUSTED,
            {
                crashes: bot.crashHistory.length,
                windowMs: this.crashWindowMs,
                lastReason: reason
            },
            this.#botSource(bot)
        )

        return true
    }

    #scheduleReconnect(bot){
        if(this.closing)return
        if(this.lifecycle){this.lifecycle.request(bot.botId,bot.lastExitReason??'unexpected_stop',bot.incarnationId);return}
        if(bot.desiredState !== "running") return
        if(bot.reconnectBlocked) return
        if(bot.reconnectTimer) return

        bot.reconnectAttempts++

        const exponentialDelay =
            this.reconnectBaseDelayMs *
            2 ** Math.min(bot.reconnectAttempts - 1, 5)

        const baseDelay = Math.min(
            this.reconnectMaxDelayMs,
            exponentialDelay
        )

        const jitter = Math.floor(
            Math.random() * (this.reconnectJitterMs + 1)
        )

        const delay = baseDelay + jitter

        this.#setSupervisorStatus(bot, "reconnecting")

        this.#loggerFor(bot).warn("Reconnect scheduled", {
            attempt: bot.reconnectAttempts,
            delay,
            lastReason: bot.lastExitReason
        })

        this.eventBus.publish(
            Events.RECONNECT_SCHEDULED,
            {
                attempt: bot.reconnectAttempts,
                delay,
                lastReason: bot.lastExitReason
            },
            this.#botSource(bot)
        )

        bot.reconnectTimer = setTimeout(() => {
            bot.reconnectTimer = null

            if(bot.desiredState !== "running") return
            if(bot.reconnectBlocked) return

            this.#startBotProcess(bot)
        }, delay)
    }

    #checkHeartbeats(){
        const now = Date.now()

        for(const bot of this.bots.values()){
            if(!bot.isRunning()) continue
            if(!bot.lastHeartbeatAt) continue

            const elapsed = now - bot.lastHeartbeatAt
            if(elapsed <= this.heartbeatTimeoutMs) continue
            if(bot.supervisorStatus === "unresponsive") continue

            this.#loggerFor(bot).error("Worker heartbeat timed out", {
                lastHeartbeatAt: bot.lastHeartbeatAt,
                elapsed
            })

            this.eventBus.publish(
                Events.WORKER_UNRESPONSIVE,
                {
                    workerPid: bot.workerPid,
                    lastHeartbeatAt: bot.lastHeartbeatAt,
                    elapsed
                },
                this.#botSource(bot)
            )

            this.#setSupervisorStatus(bot, "unresponsive")
            if(this.lifecycle)this.lifecycle.request(bot.botId,'heartbeat_timeout',bot.incarnationId)
            else bot.kill("heartbeat_timeout")
        }
    }

    #resetCrashProtection(bot){
        bot.reconnectBlocked = false
        bot.reconnectAttempts = 0
        bot.crashHistory = []
    }

    #setDesiredState(bot, desiredState){
        if(bot.desiredState === desiredState) return

        const previousDesiredState = bot.desiredState
        bot.desiredState = desiredState

        this.eventBus.publish(
            Events.BOT_DESIRED_STATE_CHANGED,
            {
                previousDesiredState,
                desiredState
            },
            this.#botSource(bot)
        )
    }

    #setSupervisorStatus(bot, status){
        if(bot.supervisorStatus === status) return

        const previousStatus = bot.supervisorStatus
        bot.supervisorStatus = status

        this.eventBus.publish(
            Events.BOT_SUPERVISOR_STATUS_CHANGED,
            {
                previousStatus,
                status
            },
            this.#botSource(bot)
        )
    }

    #normalizeDefinition(row){
        return {
            botId: Number(row.botId),
            name: row.name || `Bot ${row.botId}`,
            type: row.type || "reseller",
            serverId: row.serverId ?? null,
            realm: row.realm ?? null,
            settingsProfileId: row.settingsProfileId ?? null,
            connectedAccountId:
                row.connectedAccountId === null ||
                row.connectedAccountId === undefined
                    ? null
                    : Number(row.connectedAccountId),
            status: row.status ?? "offline",
            createdAt: row.createdAt ?? null,
            updatedAt: row.updatedAt ?? null
        }
    }

    #botSource(bot){
        return {
            kind: "bot",
            botId: bot.botId,
            accountId: bot.accountId,
            workerPid: bot.workerPid,
            incarnationId:bot.incarnationId
        }
    }

    #loggerFor(bot){
        return this.logger.withContext({
            botId: bot.botId,
            accountId: bot.accountId,
            workerPid: bot.workerPid
        })
    }

    #clearReconnectTimer(bot){
        if(!bot.reconnectTimer) return

        clearTimeout(bot.reconnectTimer)
        bot.reconnectTimer = null
    }

    #clearStableTimer(bot){
        if(!bot.stableTimer) return

        clearTimeout(bot.stableTimer)
        bot.stableTimer = null
    }
}
