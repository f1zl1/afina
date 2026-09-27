import mineflayer from "mineflayer"
import {proxyConnect} from './worker/proxyTransport.js'

import BotEventHandler from "./handlers/botEventHandler.js"
import CaptchaHandler from "./handlers/captchaHandler.js"
import BotTaskRunner from "./taskRunner/botTaskRunner.js"
import AntiAfkManager from './runtime/antiAfkManager.js'
import RealmReadyGate from './runtime/realmReadyGate.js'
import AfkRecovery from './runtime/afkRecovery.js'
import RuntimeIncidents from './runtime/runtimeIncidents.js'
import {runtimeConfig as readRuntimeConfig} from './runtime/runtimeConfig.js'

export default class Bot{
    #proxy
    #proxyIncarnation
    #onProxyDiagnostic
    constructor({
        accountData,
        taskData,
        serverData,
        logger,
        eventBus,
        botId,
        imageSolver,
        resellerSettingsStore,
        runtimeConfig,proxy,incarnationId,onProxyDiagnostic
    }){
        this.#proxy=proxy;this.#proxyIncarnation=incarnationId;this.#onProxyDiagnostic=onProxyDiagnostic
        this.logger = logger.child(`Bot${accountData.accountId}`)
        this.eventBus = eventBus
        this.accountId = accountData.accountId
        this.imageSolver = imageSolver
        this.accountData = accountData
        this.taskData = taskData
        this.serverData = serverData
        this.resellerSettingsStore = resellerSettingsStore
        this.status = "offline"
        this.positionStatus = "captcha"
        this.mode = "observer"
        this.client = null
        this.captcha = null
        this.captchaSolved = false
        this.botId = botId
        this.balance = null
        this.inventoryLocked = false
        this.inventoryLockedBy = null
        this.inventoryBusyCount = 0
        this.realmReadyTarget = null
        this.afkGeneration=0
        this.realmReadyGate = new RealmReadyGate({bot:this})
        this.antiAfk = new AntiAfkManager({bot:this,config:runtimeConfig})
        this.afkRecovery = new AfkRecovery({bot:this})
        this.incidents=new RuntimeIncidents({bot:this})
        this.eventBus.on('runtime:configure',policy=>this.antiAfk.configure(readRuntimeConfig(policy)))
        this.eventBus.on('bot:afkDetected',data=>{
            if(data.botId===this.botId)this.afkRecovery.request()
        })

        this.captchaHandler = new CaptchaHandler({
            bot: this,
            logger: this.logger,
            eventBus: this.eventBus,
            imageSolver: this.imageSolver,
            botId: this.botId
        })

        this.botEventHandler = new BotEventHandler({
            bot: this,
            logger: this.logger,
            eventBus: this.eventBus,
            botId: this.botId
        })

        this.taskRunner = new BotTaskRunner({
            bot: this,
            logger: this.logger,
            eventBus: this.eventBus,
            resellerSettingsStore: this.resellerSettingsStore
        })
    }

    start(){
        if(this.client) return
        this.incidents.reset();this.operationalBlock=null
        this.afkRecovery.cancel('NEW_SESSION');this.afkRecovery.failed=false
        this.realmEntryGeneration=(this.realmEntryGeneration ?? 0)+1
        this.realmEntryPending=null
        this.antiAfk.stopped=false
        this.positionStatus='captcha'
        this.realmReadyTarget=null
        this.requestedRealm=null

        this.setStatus("connecting")
        this.inventoryLocked = false
        this.inventoryLockedBy = null
        this.inventoryBusyCount = 0

        try{
            const connect=proxyConnect({proxy:this.#proxy,incarnationId:this.#proxyIncarnation,host:this.serverData.serverIp,port:this.serverData.port??25565,onDiagnostic:this.#onProxyDiagnostic})
            this.client = mineflayer.createBot({
                connect,
                port:this.serverData.port??25565,
                host: this.serverData.serverIp,
                username: this.accountData.username,
                version: this.serverData.version
            })

            const protocol = this.client._client
            protocol.removeAllListeners("world_particles")
        }catch(error){
            this.logger.error(`Bot ${this.botId}: failed to create client`, {
                error: error?.message ?? String(error)
            })

            this.client = null
            this.setStatus("offline")
            return
        }

        const client = this.client

        client.on('end',()=>{this.afkRecovery.cancel('DISCONNECTED');this.antiAfk.stop('DISCONNECTED');this.realmReadyGate.invalidate()})
        client.on('kicked',()=>{this.afkRecovery.cancel('KICKED');this.antiAfk.stop('KICKED');this.realmReadyGate.invalidate()})
        client.on('death',()=>this.setPositionStatus('dead'))
        client.on('windowOpen',()=>this.antiAfk.cancel('WINDOW_OPENED'))
        client.on('windowClose',()=>this.antiAfk.sync())
        client.on('physicsTick',()=>this.antiAfk.observeMovement())

        try{
            this.captchaHandler.register(client)
            this.botEventHandler.register(client)
        }catch(error){
            this.logger.error(`Bot ${this.botId}: failed to register handlers`, {
                error: error?.message ?? String(error)
            })
        }
    }

    stop(){
        this.incidents.stop()
        this.afkRecovery.cancel('BOT_STOPPING')
        this.realmEntryGeneration=(this.realmEntryGeneration ?? 0)+1
        this.antiAfk.stop('BOT_STOPPING')
        this.realmReadyGate.invalidate()
        this.taskRunner.stop()
        const client = this.client
        if(!client) return

        this.inventoryLocked = false
        this.inventoryLockedBy = null
        this.inventoryBusyCount = 0

        try{
            client.quit("Bot stopped")
        }catch(error){
            this.logger.warn(`Bot ${this.botId}: error while stopping`, {
                error: error?.message ?? String(error)
            })
        }
    }

    restart(){
        this.stop()
        this.start()
    }

    setStatus(newStatus){
        if(this.status === newStatus) return false

        const previousStatus = this.status
        this.status = newStatus
        if(newStatus!=='running')this.afkRecovery.cancel('STATUS_'+newStatus)
        this.antiAfk.sync('STATUS_'+newStatus)
        if(newStatus!=='running')this.realmReadyGate.invalidate()

        this.eventBus.emit("bot:statusChanged", {
            botId: this.botId,
            previousStatus,
            status: newStatus
        })

        return true
    }

    setPositionStatus(status){
        if(this.positionStatus === status) return false

        const previousPositionStatus = this.positionStatus
        this.positionStatus = status
        this.realmReadyTarget = status==='realm'?this.accountData.realm:null
        if(status==='realm')this.realmReadyGate.enter()
        else this.realmReadyGate.invalidate()
        this.antiAfk.sync('POSITION_'+status)

        this.eventBus.emit("bot:positionStatusUpdated", {
            botId: this.botId,
            previousPositionStatus,
            newStatus: status
        })
        this.afkRecovery.positionChanged(status)

        return true
    }

    setBalance(balance){
        if(this.balance === balance) return false

        this.balance = balance
        return true
    }

    lockInventory(owner){
        if(this.inventoryLocked && this.inventoryLockedBy !== owner) return false

        this.inventoryLocked = true
        this.inventoryLockedBy = owner
        this.antiAfk.cancel('INVENTORY_LOCKED')

        return true
    }

    unlockInventory(owner){
        if(!this.inventoryLocked) return true
        if(this.inventoryLockedBy && this.inventoryLockedBy !== owner) return false

        this.inventoryLocked = false
        this.inventoryLockedBy = null

        this.antiAfk.sync()

        return true
    }

    isInventoryLocked(){
        return this.inventoryLocked
    }

    beginInventoryOperation(){
        this.antiAfk.cancel('INVENTORY_BUSY')
        this.inventoryBusyCount++
        return this.inventoryBusyCount
    }

    endInventoryOperation(){
        this.inventoryBusyCount = Math.max(0, this.inventoryBusyCount - 1)
        return this.inventoryBusyCount
    }

    isInventoryBusy(){
        return this.inventoryBusyCount > 0
    }

    async waitForInventoryUnlock({
        canContinue = null,
        pollInterval = 50
    } = {}){
        while(this.inventoryLocked){
            if(canContinue && !canContinue()) return false
            await new Promise(resolve => setTimeout(resolve, pollInterval))
        }

        return true
    }
}
