import BotStore from "./botStore.js"
import {
    renderBotList,
    renderSelectedBot,
    appendEvent,
    appendChat,
    clearStreams,
    setActionsDisabled
} from "./ui.js"

export default class BotController{
    constructor({api}){
        this.api = api
        this.store = new BotStore()
    }

    async connected(){
        try{
            await this.loadBots()
        }catch(error){
            console.error(error)
        }
    }

    disconnected(){
        this.store.clearSubscription()
    }

    async loadBots(){
        const response = await this.api.request("query", "bots.get", {})

        if(!response.ok){
            throw new Error(response.error?.message ?? "Failed to load bots")
        }

        this.store.setBots(response.data)
        this.#renderList()

        if(this.store.selectedBotId && this.store.bots.has(this.store.selectedBotId)){
            await this.selectBot(this.store.selectedBotId)
            return
        }

        const firstBotId = this.store.bots.keys().next().value

        if(firstBotId !== undefined){
            await this.selectBot(firstBotId)
        }else{
            this.store.selectedBotId = null
            renderSelectedBot(this.store)
        }
    }

    async refreshOverview(){
        if(this.refreshingOverview || !this.api.isConnected()) return
        this.refreshingOverview = true
        const version = this.store.selectionVersion
        try{
            const response = await this.api.request("query", "bots.get", {})
            if(!response.ok || version !== this.store.selectionVersion) return
            this.store.setBots(response.data)
            if(this.store.selectedBotId && !this.store.bots.has(this.store.selectedBotId)){
                this.store.selectedBotId = null
                this.store.clearSubscription()
                clearStreams()
            }
            this.#renderList()
            renderSelectedBot(this.store)
        }finally{
            this.refreshingOverview = false
        }
    }

    async createBot({
        name = null,
        type = "test",
        connectedAccountId = null,
        serverId = null,
        realm = null
    }){
        const response = await this.api.request("command", "bot.create", {
            name,
            type,
            connectedAccountId,
            serverId,
            realm
        })

        if(!response.ok){
            throw new Error(response.error?.message ?? "Failed to create bot")
        }

        await this.loadBots()

        const botId = response.data?.bot?.botId

        if(botId){
            await this.selectBot(botId)
        }

        return response.data?.bot ?? null
    }

    async archiveSelectedBot(){
        const botId = this.store.selectedBotId
        if(!botId) return false

        const response = await this.api.request("command", "bot.archive", {
            botId
        })

        if(!response.ok){
            throw new Error(response.error?.message ?? "Failed to archive bot")
        }

        if(this.store.subscribedBotId === botId){
            await this.api.unsubscribeBot(botId).catch(() => {})
        }

        this.store.selectedBotId = null
        this.store.clearSubscription()
        clearStreams()

        await this.loadBots()

        return true
    }

    async selectBot(botId){
        botId = Number(botId)
        if(!this.store.bots.has(botId)) return

        const oldBotId = this.store.subscribedBotId

        if(oldBotId && oldBotId !== botId){
            await this.api.unsubscribeBot(oldBotId).catch(() => {})
            this.store.clearSubscription()
        }

        const version = this.store.startSelection(botId)

        clearStreams()
        this.#renderList()
        renderSelectedBot(this.store)

        if(this.store.subscribedBotId !== botId){
            await this.api.subscribeBot(botId)

            if(this.store.selectionVersion !== version) return
            this.store.subscribedBotId = botId
        }

        const [botResponse, historyResponse, chatResponse] = await Promise.all([
            this.api.request("query", "bot.get", {botId}),
            this.api.request("query", "bot.history.get", {
                botId,
                limit: 100
            }),
            this.api.request("query", "bot.chat.history.get", {
                botId,
                limit: 100
            })
        ])

        if(this.store.selectionVersion !== version || this.store.selectedBotId !== botId) return

        if(botResponse.ok){
            this.store.setBot(botId, botResponse.data)
            this.#renderList()
            renderSelectedBot(this.store)
        }

        if(historyResponse.ok){
            for(const event of historyResponse.data?.events ?? []){
                this.#displayEvent(event)
            }
        }

        if(chatResponse.ok){
            for(const event of chatResponse.data?.events ?? []){
                this.#displayEvent(event)
            }
        }

        const queuedEvents = this.store.finishSync(botId)

        for(const event of queuedEvents){
            this.#displayEvent(event)
        }
    }

    async submitConsole(botId, text){
        const response = await this.api.request("command", "bot.console", {botId, text})
        if(!response.ok) throw new Error(response.error?.message ?? "Не вдалося виконати запит.")
        return response.data
    }

    async executeCommand(command){
        const botId = this.store.selectedBotId
        if(!botId) return

        setActionsDisabled(true)

        try{
            const response = await this.api.request("command", command, {botId})

            if(!response.ok){
                window.alert(response.error?.message ?? "Command failed")
            }
        }catch(error){
            window.alert(error?.message ?? "Command failed")
        }finally{
            setActionsDisabled(false, this.store)
        }
    }

    handleEvent(event){
        if(!event) return

        const botId = Number(event.source?.botId)

        if(!this.store.selectedBotId || botId !== this.store.selectedBotId){
            return
        }

        if(this.store.syncingBotId === botId){
            this.store.queueEvent(event)
            return
        }

        this.#displayEvent(event)

        if(event.type !== "bot.chat.message"){
            this.#scheduleRefresh()
        }
    }

    #displayEvent(event){
        if(!this.store.rememberEvent(event)) return

        if(event.type === "bot.chat.message"){
            appendChat(event)
        }else{
            appendEvent(event)
        }
    }

    #scheduleRefresh(){
        clearTimeout(this.store.refreshTimer)

        this.store.refreshTimer = setTimeout(() => {
            this.#refreshSelectedBot().catch(console.error)
        }, 150)
    }

    async #refreshSelectedBot(){
        const botId = this.store.selectedBotId
        if(!botId || !this.api.isConnected()) return

        const response = await this.api.request("query", "bot.get", {botId})

        if(!response.ok || this.store.selectedBotId !== botId) return

        this.store.setBot(botId, response.data)
        this.#renderList()
        renderSelectedBot(this.store)
    }

    #renderList(){
        renderBotList(this.store, botId => {
            this.selectBot(botId).catch(console.error)
        })
    }
}
