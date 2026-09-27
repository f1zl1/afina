import { createHash } from "node:crypto"
import {runtimeConfig} from '../minecraftBot/runtime/runtimeConfig.js'

const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const labels = {definition: "бот", accountData: "акаунт", taskData: "завдання / предмет", serverData: "сервер", settings: "налаштування поведінки"}

export default class BotConfigurationService{
    constructor({botManager, dataBaseManager, eventBus, logger, config = {}}){
        Object.assign(this, {botManager, dataBaseManager, eventBus})
        this.logger = logger.child("BotConfigurationService")
        this.autoRestart = config.autoRestartOnSettingsChange === true
        this.states = new Map()
        this.restarts = new Map()
        this.queue = Promise.resolve()
    }

    async init(){
        await this.sync()
        this.timer = setInterval(() => this.sync().catch(error => this.logger.error("Configuration sync failed", {error: error.message})), 2000)
        this.timer.unref?.()
    }

    sync(){
        const next = this.queue.then(() => this.refresh())
        this.queue = next.catch(() => {})
        return next
    }

    async read(botId, snapshot = null){
        const db = this.dataBaseManager
        const payload = (snapshot ?? db.getConfigurationSnapshot()).configurations.get(botId)
        if(!payload) throw new Error(`Bot ${botId} no longer exists`)
        if(payload.error) throw new Error(payload.error)
        const {definition, accountData, taskData, serverData, settings} = payload
        const comparison = {
            definition: {connectedAccountId:definition.connectedAccountId,serverId:definition.serverId,realm:definition.realm},
            accountData: accountData ? Object.fromEntries(Object.entries(accountData).filter(([key])=>key !== "telegramAccountId")) : accountData,taskData,serverData,
            settings: ["reseller","afk"].includes(taskData?.type) && taskData?.enabled !== 0 ? settings : null
        }
        return {...payload,comparison,fingerprint:hash(comparison)}
    }

    async refresh(){
        const snapshot = this.dataBaseManager.getConfigurationSnapshot()
        if(snapshot && snapshot.revision === this.lastRevision){
            for(const [id,state] of this.states) this.scheduleRestart(id,state)
            return
        }
        await this.botManager.synchronizeDefinitions()
        let changed = false
        const ids = new Set(this.botManager.getBotDefinitions().map(bot => bot.botId))
        for(const id of this.states.keys()){
            if(!ids.has(id)){
                this.states.delete(id)
                clearTimeout(this.restarts.get(id))
                this.restarts.delete(id)
                changed = true
            }
        }
        for(const botId of ids){
            const previous = this.states.get(botId)
            try{
                const current = await this.read(botId, snapshot)
                const state = previous ?? {applied: current, changedAt: null, error: null}
                if(!previous || previous.current?.fingerprint !== current.fingerprint || state.error){
                    changed = true
                    state.changedAt = Date.now()
                    state.error = null
                }
                state.current = current
                this.states.set(botId, state)
                this.scheduleRestart(botId, state)
            }catch(error){
                const state = previous ?? {applied: null, current: null}
                changed ||= state.error !== error.message
                state.error = error.message
                this.states.set(botId, state)
            }
        }
        if(changed){
            this.eventBus.publish("system.bots.changed", {})
        }
        if(snapshot) this.lastRevision = snapshot.revision
    }

    status(botId){
        const state = this.states.get(botId)
        const current = state?.current
        const error = state?.error ?? (current && (
            !current.accountData ? "Призначте акаунт боту." :
            !current.serverData ? "Вкажіть сервер у налаштуваннях бота." :
            !Number.isInteger(current.definition.realm) ? "Вкажіть номер анархії у налаштуваннях бота." : null
        ))
        const restartRequired = Boolean(state && (error || state.applied?.fingerprint !== current?.fingerprint))
        return {
            restartRequired,
            changedAt: restartRequired ? state.changedAt : null,
            changes: restartRequired ? Object.keys(labels).filter(key => hash(state.applied?.comparison?.[key] ?? null) !== hash(state.current?.comparison?.[key] ?? null)).map(key => labels[key]) : [],
            error: error ?? null,
            autoRestart: this.autoRestart
        }
    }

    async prepare(bot){
        const current = structuredClone(await this.read(bot.botId))
        if(!current.accountData || !current.serverData) throw new Error("Bot account or server is missing")
        if(current.definition && !Number.isInteger(current.definition.realm)) throw new Error("Set the bot realm before starting")
        bot.accountId = current.accountData.accountId
        bot.accountData = current.accountData
        bot.taskData = current.taskData
        bot.serverData = current.serverData
        bot.resellerSettings = current.settings
        bot.runtimeConfig = runtimeConfig(this.dataBaseManager.store?.prepare('SELECT * FROM corePolicy WHERE id=1').get())
        bot.pendingConfiguration = current
        this.botManager.snapshotStore?.updateConfiguration(bot.botId, current)
    }

    applied(bot){
        if(!bot.pendingConfiguration) return
        const state = this.states.get(bot.botId) ?? {}
        state.applied = bot.pendingConfiguration
        state.current ??= state.applied
        state.error = null
        this.states.set(bot.botId, state)
        bot.pendingConfiguration = null
        this.eventBus.publish("system.bots.changed", {})
    }

    scheduleRestart(botId, state){
        if(this.closed)return
        const bot = this.botManager.getBot(botId)
        const status = this.status(botId)
        if(!this.autoRestart || !status.restartRequired || status.error ||
            !bot || bot.operationalBlock || bot.reconnectBlocked || bot.desiredState !== "running" || bot.startingConfiguration ||
            ["starting", "stopping"].includes(bot.supervisorStatus) || this.restarts.has(botId) ||
            state.lastAttempt === state.current.fingerprint) return
        this.restarts.set(botId, setTimeout(async () => {
            this.restarts.delete(botId)
            const currentBot=this.botManager.getBot(botId)
            if(!this.status(botId).restartRequired || currentBot?.desiredState !== "running" || currentBot.operationalBlock || currentBot.reconnectBlocked) return
            state.lastAttempt = state.current.fingerprint
            try{
                await this.botManager.restartBot(botId,{reason:'configuration',incarnationId:currentBot.incarnationId})
            }catch(error){
                state.error = error.message
                this.eventBus.publish("system.bots.changed", {})
            }
        }, 750))
    }

    destroy(){
        this.closed=true
        clearInterval(this.timer)
        for(const timer of this.restarts.values()) clearTimeout(timer)
        this.restarts.clear()
    }
}
