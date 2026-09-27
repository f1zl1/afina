import { randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import { fork } from "node:child_process"
import { fileURLToPath } from "node:url"
import { Events } from "../events/events.js"
import {sanitizeWorkerFacts} from '../minecraftBot/worker/workerFacts.js'

const processExists=pid=>{try{process.kill(pid,0);return true}catch(error){return error.code==='ESRCH'?false:error.code==='EPERM'?true:null}}

const workerPath = fileURLToPath(
    new URL("../minecraftBot/worker/botWorker.js", import.meta.url)
)

export default class BotProcess extends EventEmitter{
    constructor({
        botId,
        accountData,
        taskData,
        serverData,
        resellerSettings,
        logger,
        eventBus,
        imageSolver,
        forkWorker=fork,
        probeProcess=processExists
    }){
        super()

        this.botId = botId
        this.accountId = accountData.accountId
        this.accountData = accountData
        this.taskData = taskData
        this.serverData = serverData
        this.resellerSettings = resellerSettings
        this.rootLogger = logger
        this.logger = logger.child(`BotProcess${botId}`)
        this.eventBus = eventBus
        this.imageSolver = imageSolver
        this.forkWorker=forkWorker;this.probeProcess=probeProcess
        this.incarnationId=null;this.factCache=null;this.factRequest=null;this.factFailure=null
        this.lastObservedAt=null;this.lastEventAt=null;this.lastFactAttemptAt=null

        this.chatRequests = new Map()
        this.process = null
        this.workerPid = null
        this.startedAt = null
        this.lastHeartbeatAt = null
        this.pendingExitReason = null
        this.pendingExitContext = null

        this.supervisorStatus = "offline"
        this.runtimeStatus = "offline"
        this.analysisState = 'unavailable'
        this.workReady=false
        this.operationalBlock=null
        this.desiredState = "stopped"

        this.reconnectAttempts = 0
        this.reconnectTimer = null
        this.stableTimer = null
        this.restartRequested = false
        this.reconnectBlocked = false
        this.crashHistory = []
        this.lastExitReason = null
        this.lastExitAt = null
        this.stopTimer = null
    }

    start({beforeSpawn=null,proxyLifecycle=null}={}){
        if(this.process) return false

        this.workReady=false
        this.operationalBlock=null

        this.pendingExitReason = null
        this.pendingExitContext = null
        this.startedAt = Date.now()
        this.lastHeartbeatAt = Date.now()
        this.runtimeStatus = "offline"
        this.analysisState = 'unavailable'

        const incarnationId=this.incarnationId=randomUUID()
        this.cancelQuiescence('INCARNATION_MISMATCH')
        this.stopEvidence=null
        this.cancelFactRequest('INCARNATION_MISMATCH')
        this.factCache=null;this.factFailure=null;this.lastObservedAt=null;this.lastEventAt=null;this.lastFactAttemptAt=null

        const proxy=beforeSpawn?.(incarnationId)
        if(this.forkWorker===fork&&!proxy)throw new Error('AUTHORIZED_PROXY_REQUIRED')
        let child
        try{child = this.forkWorker(workerPath, [], {
            stdio: ["inherit", "inherit", "inherit", "ipc"],
            serialization: "advanced"
        })}catch(error){proxyLifecycle?.release(incarnationId,'SPAWN_FAILED');throw error}
        proxyLifecycle?.spawned(incarnationId,child.pid,false)

        this.process = child
        this.workerPid = child.pid ?? null

        child.on("message", message => {
            if(message?.type==='proxy:diagnostic'&&this.process===child&&message.incarnationId===incarnationId){proxyLifecycle?.diagnostic(incarnationId,message.code);if(proxyLifecycle?.transport(incarnationId,message.code,message.connectionId))this.eventBus.publish('bot.proxy.changed',{incarnationId},{kind:'bot',botId:this.botId,workerPid:child.pid,incarnationId});return}
            this.#handleMessage(child, message).catch(error => {
                this.#processLogger().error("Worker message handling failed", {
                    error: error?.message ?? String(error),
                    stack: error?.stack ?? null
                })
            })
        })

        child.on("error", error => {
            if(!child.pid)proxyLifecycle?.release(incarnationId,'SPAWN_FAILED')
            if(this.process===child)this.cancelFactRequest('WORKER_FACTS_UNAVAILABLE')
            this.#processLogger().error("Worker process error", {
                error: error?.message ?? String(error),
                stack: error?.stack ?? null
            })
        })

        child.once("exit", (code, signal) => {
            proxyLifecycle?.release(incarnationId,'PROCESS_EXITED')
            this.#onExit(child, code, signal)
        })
        child.once('disconnect',()=>{if(this.process===child){proxyLifecycle?.clearTransport(incarnationId);this.cancelFactRequest('WORKER_IPC_DISCONNECTED');this.cancelQuiescence('STOP_TRANSPORT_UNAVAILABLE')}})

        child.once("spawn", () => {
            if(this.process!==child||this.incarnationId!==incarnationId)return
            this.workerPid = child.pid ?? null
            proxyLifecycle?.spawned(incarnationId,child.pid)
            this.startedAt = Date.now()
            this.lastHeartbeatAt = Date.now()

            this.#sendTo(child, {
                type: "init",
                payload: {
                    botId: this.botId,
                    incarnationId,
                    proxy,
                    accountData: this.accountData,
                    taskData: this.taskData,
                    serverData: this.serverData,
                    resellerSettings: this.resellerSettings,
                    runtimeConfig: this.runtimeConfig
                }
            })
        })

        return true
    }

    stop(reason = "manual_stop",{escalate=true}={}){
        this.cancelFactRequest('WORKER_STOPPING')
        const child = this.process
        if(!child) return false

        this.pendingExitReason = reason
        this.pendingExitContext = null

        this.#sendTo(child, {
            type: "command",
            command: "stop",
            reason
        })

        this.#clearStopTimer()

        if(!escalate)return true
        this.stopTimer = setTimeout(() => {
            this.stopTimer = null

            if(this.process !== child) return

            this.#processLogger().warn("Worker did not stop gracefully, killing", {
                reason
            })

            this.kill(reason)
        }, 5000)

        return true
    }

    kill(reason = "worker_killed"){
        this.cancelFactRequest('WORKER_STOPPING')
        const child = this.process
        if(!child) return false

        this.pendingExitReason = reason

        try{
            return child.kill()
        }catch(error){
            this.#processLogger().warn("Failed to kill worker", {
                error: error?.message ?? String(error)
            })

            return false
        }
    }

    requestQuiescence({actionId,deadlineAt,valid=()=>true,onProgress=()=>{}}){
        if(this.quiescenceRequest?.actionId===actionId)return this.quiescenceRequest.promise
        this.cancelQuiescence('STOP_SUPERSEDED')
        const child=this.process,incarnationId=this.incarnationId
        if(!child)return Promise.resolve({absent:true})
        const request={actionId,child,incarnationId,valid,onProgress}
        request.promise=new Promise((resolve,reject)=>{
            request.finish=(error,value)=>{
                if(this.quiescenceRequest!==request)return
                clearTimeout(request.timer);this.quiescenceRequest=null
                error?reject(new Error(error)):resolve(value)
            }
            request.timer=setTimeout(()=>request.finish('GRACEFUL_STOP_TIMEOUT'),Math.max(1,deadlineAt-Date.now()))
        })
        this.quiescenceRequest=request
        if(!valid()||!this.#sendTo(child,{type:'lifecycle:quiesce',actionId,incarnationId}))request.finish('STOP_TRANSPORT_UNAVAILABLE')
        return request.promise
    }
    cancelQuiescence(reason){this.quiescenceRequest?.finish(reason)}

    isRunning(){
        return Boolean(this.process)
    }

    sendChat(text){
        const child = this.process
        if(!child?.connected) return Promise.reject(new Error("Бот не підключений."))
        const id = randomUUID()
        return new Promise((resolve, reject) => {
            const finish = (error = null) => {
                clearTimeout(timer)
                this.chatRequests.delete(id)
                if(error) reject(new Error(error))
                else resolve()
            }
            const timer = setTimeout(() => {
                finish("Немає підтвердження від бота. Повідомлення могло бути надіслане; перевірте чат перед повтором.")
            }, 5000)
            this.chatRequests.set(id, {child, finish})
            try{
                child.send({type: "chat:request", id, text}, error => {
                    if(error && this.chatRequests.has(id)) finish(error.message)
                })
            }catch(error){
                finish(error.message)
            }
        })
    }

    sendEvent(event, context = {}){
        const child = this.process
        if(!child) return false

        return this.#sendTo(child, {
            type: "event",
            event,
            context
        })
    }

    getRuntimeState(){
        return {
            botId: this.botId,
            accountId: this.accountId,
            desiredState: this.desiredState,
            supervisorStatus: this.supervisorStatus,
            runtimeStatus: this.runtimeStatus,
            running: this.isRunning(),
            workerPid: this.workerPid,
            incarnationId:this.incarnationId,
            startedAt: this.startedAt,
            lastHeartbeatAt: this.lastHeartbeatAt,
            reconnectAttempts: this.reconnectAttempts,
            reconnectBlocked: this.reconnectBlocked,
            recentCrashes: this.crashHistory.length,
            lastExitReason: this.lastExitReason,
            lastExitAt: this.lastExitAt
        }
    }

    async #handleMessage(child, message){
        if(!message || typeof message !== "object") return
        // Applies to ready/heartbeat/exitReason as well as semantic events.
        if(this.process!==child)return
        if(message.type==='lifecycle:quiescence'){
            const r=this.quiescenceRequest
            if(!r||r.child!==child||message.actionId!==r.actionId||message.incarnationId!==r.incarnationId||this.incarnationId!==r.incarnationId)return
            if(!r.valid()){r.finish('STOP_SUPERSEDED');return}
            if(!['quiescing','unsafe','safe'].includes(message.state)||typeof message.safe!=='boolean'||message.safe!==(message.state==='safe')){r.finish('INVALID_STOP_EVIDENCE');return}
            const evidence={actionId:r.actionId,incarnationId:r.incarnationId,state:message.state,safe:message.safe,reason:typeof message.reason==='string'&&/^[A-Z_]{1,96}$/.test(message.reason)?message.reason:null,observedAt:Date.now()}
            this.stopEvidence=evidence
            if(r.lastState!==evidence.state){r.lastState=evidence.state;r.onProgress(evidence)}
            if(evidence.safe)r.finish(null,evidence)
            else if(evidence.state==='unsafe')r.finish(evidence.reason??'UNSAFE_STOP')
            return
        }
        if(['runtime:facts','publicEvent','ready','heartbeat','exitReason'].includes(message.type)&&message.incarnationId!==this.incarnationId)return
        if(message.type==='runtime:facts'){
            const request=this.factRequest
            if(!request||request.child!==child||request.id!==message.requestId)return
            const accepted=this.acceptFacts(message.facts,'worker_query')
            request.finish(accepted?null:'WORKER_FACTS_INVALID')
            return
        }

        if(message.type === "chat:response"){
            const request = this.chatRequests.get(message.id)
            if(request?.child === child) request.finish(message.error ?? null)
            return
        }

        if(message.type === "ready"){
            this.#processLogger().info("Worker ready")

            this.emit("ready", {
                workerPid: this.workerPid,
                startedAt: this.startedAt
            })

            return
        }

        if(message.type === "heartbeat"){
            this.lastHeartbeatAt = Date.now()
            return
        }

        if(message.type === "exitReason"){
            this.pendingExitReason = message.reason ?? "worker_exit"
            this.pendingExitContext = message.context ?? null
            return
        }

        if(message.type === "publicEvent"){
            if(this.process!==child) return
            const event = message.event
            if(event?.source?.incarnationId!==this.incarnationId)return
            this.lastEventAt=Date.now()
            if(message.facts&&!this.acceptFacts(message.facts,'worker_event'))return
            if(this.beforePublicEvent && this.beforePublicEvent(event)===false)return
            if(event?.type==='bot.runtime.ready')this.workReady=true
            if(event?.type===Events.BOT_POSITION_CHANGED && event.payload?.position!=='realm')this.workReady=false
            if(event?.type===Events.BOT_STATUS_CHANGED && event.payload?.status!=='running')this.workReady=false

            if(event?.type==='bot.analysis.status') this.analysisState=event.payload?.state ?? 'unavailable'

            if(event?.type === Events.BOT_STATUS_CHANGED){
                this.runtimeStatus = event.payload?.status ?? this.runtimeStatus
            }

            this.eventBus.publishEnvelope(event)

            this.emit("workerEvent", {
                event: event?.type,
                context: event?.payload ?? {}
            })

            return
        }

        if(message.type === "log"){
            await this.rootLogger.log({
                source: message.source ?? `Bot${this.botId}`,
                message: message.message ?? "",
                context: message.context ?? {},
                type: message.level ?? "info",
                scope: "bot",
                botId: this.botId,
                accountId: this.accountId,
                workerPid: this.workerPid
            })

            return
        }

        if(message.type === "rpc:request"){
            await this.#handleRpcRequest(child, message)
        }
    }

    async #handleRpcRequest(child, message){
        const id = message.id

        if(message.service !== "imageSolver"){
            this.#sendTo(child, {
                type: "rpc:response",
                id,
                error: `Unknown RPC service: ${message.service}`
            })

            return
        }

        try{
            const image = message.payload?.image

            if(typeof image !== "string"){
                throw new Error("Image payload is missing")
            }

            const result = await this.imageSolver.solve(
                Buffer.from(image, "base64")
            )

            this.#sendTo(child, {
                type: "rpc:response",
                id,
                result
            })
        }catch(error){
            this.#sendTo(child, {
                type: "rpc:response",
                id,
                error: error?.message ?? String(error)
            })
        }
    }

    #onExit(child, code, signal){
        if(this.process !== child) return
        this.quiescenceRequest?.finish(null,{absent:true})
        this.cancelFactRequest('PROCESS_MISSING')
        this.workReady=false

        for(const request of this.chatRequests.values()){
            request.finish("Бот відключився до підтвердження надсилання.")
        }

        const reason = this.pendingExitReason ?? "worker_crash"
        const context = this.pendingExitContext

        this.#clearStopTimer()

        this.process = null
        this.workerPid = null
        this.lastHeartbeatAt = null
        this.runtimeStatus = "offline"
        this.analysisState = 'unavailable'
        this.pendingExitReason = null
        this.pendingExitContext = null

        this.emit("exit", {
            code,
            signal,
            reason,
            context
        })
    }

    #sendTo(child, message){
        if(!child || !child.connected) return false

        try{
            child.send(message, error => {
                if(!error) return
                if(message.type==='runtime:getFacts'&&this.factRequest?.id===message.requestId)this.cancelFactRequest('WORKER_IPC_DISCONNECTED')
                if(message.type==='lifecycle:quiesce'&&this.quiescenceRequest?.actionId===message.actionId)this.cancelQuiescence('STOP_TRANSPORT_UNAVAILABLE')

                this.#processLogger().warn("IPC send failed", {
                    error: error?.message ?? String(error)
                })
            })

            return true
        }catch(error){
            this.#processLogger().warn("IPC send failed", {
                error: error?.message ?? String(error)
            })

            return false
        }
    }

    #processLogger(){
        return this.logger.withContext({
            botId: this.botId,
            accountId: this.accountId,
            workerPid: this.workerPid
        })
    }

    #clearStopTimer(){
        if(!this.stopTimer) return

        clearTimeout(this.stopTimer)
        this.stopTimer = null
    }

    observeProcess(){
        const child=this.process
        const alive=!child?false:child.exitCode!=null||child.signalCode!=null?false:Number.isInteger(child.pid)?this.probeProcess(child.pid):null
        return {alive,ipcConnected:alive!==false&&child?.connected===true,pid:child?.pid??null,incarnationId:this.incarnationId,startedAt:this.startedAt,observedAt:Date.now(),source:'process_observation'}
    }
    acceptFacts(value,source){
        const facts=sanitizeWorkerFacts(value)
        if(!facts||facts.incarnationId!==this.incarnationId||facts.botId!==this.botId||facts.accountId!==this.accountId)return false
        if(this.factCache&&facts.sequence<=this.factCache.facts.sequence)return false
        const at=Date.now();this.factCache={facts,receivedAt:at,source};this.factFailure=null
        if(source==='worker_query')this.lastObservedAt=at
        return true
    }
    getWorkerObservation({now=Date.now(),freshMs=15000}={}){
        const evidence=this.observeProcess(),cache=this.factCache
        if(evidence.alive===false)this.cancelFactRequest('PROCESS_MISSING')
        const quality=evidence.alive===false?'PROCESS_MISSING':evidence.alive!==true||this.factFailure?'UNAVAILABLE':!cache?'UNAVAILABLE':cache.facts.incarnationId!==this.incarnationId?'INCARNATION_MISMATCH':now-cache.receivedAt>freshMs?'STALE':'FRESH'
        return {botId:this.botId,process:evidence,quality,facts:cache?.facts??null,source:cache?.source??'process_observation',
            lastObservedAt:this.lastObservedAt,lastEventAt:this.lastEventAt,lastReceivedAt:cache?.receivedAt??null,lastAttemptAt:this.lastFactAttemptAt,
            ageMs:cache?Math.max(0,now-cache.receivedAt):null,reason:quality==='PROCESS_MISSING'?'PROCESS_MISSING':this.factFailure??(quality==='STALE'?'WORKER_OBSERVATION_STALE':!cache?'WORKER_FACTS_UNAVAILABLE':null),
            intent:{desiredState:this.desiredState,supervisorStatus:this.supervisorStatus,reconnectBlocked:this.reconnectBlocked,reconnectScheduled:Boolean(this.reconnectTimer),reconnectAttempts:this.reconnectAttempts,startingConfiguration:Boolean(this.startingConfiguration),restartRequested:this.restartRequested},
            operationalBlock:this.operationalBlock?{type:this.operationalBlock.type}:null}
    }
    cancelFactRequest(reason='OBSERVATION_CANCELLED'){this.factRequest?.finish(reason)}
    requestFacts({timeoutMs=1000,signal}={}){
        if(signal?.aborted)return Promise.resolve({ok:false,reason:'OBSERVATION_CANCELLED'})
        if(this.factRequest)return this.factRequest.promise
        const evidence=this.observeProcess(),child=this.process
        if(evidence.alive===false||!evidence.ipcConnected){
            this.factFailure=evidence.alive===false?'PROCESS_MISSING':'WORKER_IPC_DISCONNECTED'
            return Promise.resolve({ok:false,reason:this.factFailure})
        }
        const request={id:randomUUID(),child};this.lastFactAttemptAt=Date.now()
        request.promise=new Promise(resolve=>{
            request.finish=reason=>{
                if(this.factRequest!==request)return
                clearTimeout(request.timer);signal?.removeEventListener('abort',abort)
                this.factRequest=null;this.factFailure=reason
                resolve({ok:!reason,reason})
            }
            const abort=()=>request.finish('OBSERVATION_CANCELLED')
            request.timer=setTimeout(()=>request.finish('WORKER_FACTS_TIMEOUT'),Math.max(1,Math.min(5000,timeoutMs)))
            this.factRequest=request;signal?.addEventListener('abort',abort,{once:true})
        })
        if(!this.#sendTo(child,{type:'runtime:getFacts',requestId:request.id,incarnationId:this.incarnationId}))request.finish('WORKER_IPC_DISCONNECTED')
        return request.promise
    }
}
