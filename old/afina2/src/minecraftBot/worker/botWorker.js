import Bot from "../bot.js"
import {registerRoleLifecycle} from './roleLifecycle.js'
import { sendChat } from "./sendChat.js"
import WorkerEventBus from "./workerEventBus.js"
import WorkerLogger from "./workerLogger.js"
import WorkerImageSolver from "./workerImageSolver.js"
import WorkerSettingsStore from "./workerSettingsStore.js"
import WorkerPublicEventBridge from "./workerPublicEventBridge.js"
import WorkerFacts from './workerFacts.js'
import GracefulStop from './gracefulStop.js'

let bot = null
let eventBus = null
let imageSolver = null
let resellerSettingsStore = null
let publicEventBridge = null
let initialized = false
let stopping = false
let stoppingReason = null
let exitTimer = null
let heartbeatTimer = null
let lastKickReason = null
let incarnationId=null
let workerFacts=null
let gracefulStop=null

process.on("message", message => {
    handleMessage(message).catch(error => {
        sendWorkerError(error)

        scheduleExit(
            1,
            100,
            "worker_crash",
            {
                error: error?.message ?? String(error),
                stack: error?.stack ?? null
            }
        )
    })
})

process.on("disconnect", () => {
    scheduleExit(
        stopping ? 0 : 1,
        0,
        stoppingReason ?? "parent_disconnected"
    )
})

process.on("uncaughtException", error => {
    sendWorkerError(error)

    scheduleExit(
        1,
        100,
        "worker_crash",
        {
            error: error?.message ?? String(error),
            stack: error?.stack ?? null
        }
    )
})

process.on("unhandledRejection", reason => {
    const error = reason instanceof Error
        ? reason
        : new Error(String(reason))

    sendWorkerError(error)

    scheduleExit(
        1,
        100,
        "worker_crash",
        {
            error: error.message,
            stack: error.stack ?? null
        }
    )
})

async function handleMessage(message){
    if(!message || typeof message !== "object") return
    if(message.type==='lifecycle:quiesce'){void gracefulStop?.request(message);return}
    if(message.type==='runtime:getFacts'){
        if(message.incarnationId===incarnationId&&typeof message.requestId==='string'){
            let facts=null
            try{facts=workerFacts?.read()??null}catch{}
            send({type:'runtime:facts',requestId:message.requestId,facts})
        }
        return
    }

    if(message.type === "chat:request"){
        try{
            sendChat(bot, message.text, stopping, null, true)
            send({type: "chat:response", id: message.id})
        }catch(error){
            send({type: "chat:response", id: message.id, error: error?.message ?? String(error)})
        }
        return
    }

    if(message.type === "init"){
        initialize(message.payload)
        return
    }

    if(message.type === "command"){
        handleCommand(
            message.command,
            message.reason
        )

        return
    }

    if(message.type === "event"){
        eventBus?.emit(
            message.event,
            message.context ?? {}
        )

        return
    }

    if(message.type === "rpc:response"){
        imageSolver?.handleResponse(message)
    }
}

function initialize({
    botId,
    accountData,
    taskData,
    serverData,
    resellerSettings,
    runtimeConfig,
    proxy,
    incarnationId:instanceId
}){
    if(initialized) return

    initialized = true
    incarnationId=instanceId

    const logger = new WorkerLogger()

    eventBus = new WorkerEventBus()
    imageSolver = new WorkerImageSolver()

    resellerSettingsStore = new WorkerSettingsStore({
        settings: resellerSettings,
        eventBus
    })

    publicEventBridge = new WorkerPublicEventBridge({
        eventBus,
        logger,
        botId,
        accountId: accountData.accountId,
        incarnationId,
        getFacts:()=>workerFacts?.read()??null
    })

    publicEventBridge.register()

    bot = new Bot({
        botId,
        accountData,
        taskData,
        serverData,
        logger,
        eventBus,
        imageSolver,
        resellerSettingsStore,
        runtimeConfig,proxy,incarnationId,onProxyDiagnostic:(code,connectionId)=>send({type:'proxy:diagnostic',code,connectionId})
    })

    bot.incarnationId=incarnationId
    registerLifecycleEvents()
    workerFacts=new WorkerFacts({bot,incarnationId,isStopping:()=>stopping||Boolean(exitTimer)})
    gracefulStop=new GracefulStop({bot,incarnationId,send})
    startHeartbeat()

    send({
        type: "ready",
        botId
    })

    try{
        bot.start()

        if(!bot.client){
            scheduleExit(
                1,
                100,
                "startup_error",
                {
                    status: bot.status
                }
            )
        }
    }catch(error){
        sendWorkerError(error)

        scheduleExit(
            1,
            100,
            "startup_error",
            {
                error: error?.message ?? String(error),
                stack: error?.stack ?? null
            }
        )
    }
}

function registerLifecycleEvents(){
    registerRoleLifecycle({bot,eventBus,isStopping:()=>stopping})

    eventBus.on("bot:kicked", data => {
        if(data?.botId !== bot.botId) return
        lastKickReason = data.reason ?? null
    })

    eventBus.on("bot:disconnected", data => {
        if(data?.botId !== bot.botId) return

        bot.taskRunner.stop()

        if(stopping){
            scheduleExit(
                0,
                100,
                stoppingReason ?? "manual_stop"
            )

            return
        }

        if(lastKickReason){
            scheduleExit(
                1,
                100,
                "kicked",
                {
                    reason: lastKickReason
                }
            )

            return
        }

        scheduleExit(
            1,
            100,
            "disconnect",
            {
                reason: data.reason ?? null
            }
        )
    })

    eventBus.on("bot:fatal", data => {
        if(data?.botId !== bot.botId) return

        bot.taskRunner.stop()

        scheduleExit(
            1,
            100,
            data.reason ?? "fatal_error",
            {
                error: data.error ?? null,
                stack: data.stack ?? null
            }
        )
    })
}

function handleCommand(command, reason){
    if(command !== "stop") return

    stopping = true
    stoppingReason = reason ?? "manual_stop"

    bot?.taskRunner?.stop()

    if(!bot?.client){
        scheduleExit(
            0,
            0,
            stoppingReason
        )

        return
    }

    try{
        bot.stop()
    }catch(error){
        sendWorkerError(error)

        scheduleExit(
            0,
            100,
            stoppingReason,
            {
                error: error?.message ?? String(error)
            }
        )

        return
    }

    scheduleExit(
        0,
        3000,
        stoppingReason
    )
}

function startHeartbeat(){
    sendHeartbeat()

    heartbeatTimer = setInterval(() => {
        sendHeartbeat()
    }, 5000)
}

function sendHeartbeat(){
    send({
        type: "heartbeat",
        at: Date.now(),
        botId: bot?.botId ?? null
    })
}

function scheduleExit(
    code,
    delay,
    reason,
    context = null
){
    if(exitTimer) return
    bot?.afkRecovery?.cancel(reason)
    bot?.antiAfk?.stop(reason)
    bot?.realmReadyGate?.invalidate()

    send({
        type: "exitReason",
        reason,
        context
    })

    exitTimer = setTimeout(() => {
        if(heartbeatTimer){
            clearInterval(heartbeatTimer)
            heartbeatTimer = null
        }

        try{
            publicEventBridge?.destroy()
            resellerSettingsStore?.destroy()
            imageSolver?.destroy()
        }catch{}

        process.exit(code)
    }, delay)
}

function sendWorkerError(error){
    if(eventBus && bot){
        eventBus.emit("bot:error", {
            botId: bot.botId,
            error: error?.message ?? String(error),
            stack: error?.stack ?? null
        })

        return
    }

    send({
        type: "log",
        level: "error",
        source: "BotWorker",
        message: error?.message ?? String(error),
        context: {
            stack: error?.stack ?? null
        }
    })
}

function send(message){
    if(!process.connected) return false

    try{
        process.send({...message,incarnationId})
        return true
    }catch{
        return false
    }
}
