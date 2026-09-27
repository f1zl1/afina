import { Events } from "./events.js"

export default class EventHistoryStore{
    constructor({
        eventBus,
        logger,
        limit = 100
    }){
        this.eventBus = eventBus
        this.logger = logger.child("EventHistoryStore")
        this.limit = limit
        this.botHistory = new Map()
        this.botChatHistory = new Map()
        this.systemHistory = []

        this.onEvent = event => {
            this.#handleEvent(event)
        }

        this.eventBus.onAny(this.onEvent)
        this.logger.info("EventHistoryStore started", {
            limit: this.limit
        })
    }

    getBot(botId, limit = this.limit){
        return this.#getHistory(
            this.botHistory.get(Number(botId)),
            limit
        )
    }

    getBotChat(botId, limit = this.limit){
        return this.#getHistory(
            this.botChatHistory.get(Number(botId)),
            limit
        )
    }

    getSystem(limit = this.limit){
        return this.#getHistory(
            this.systemHistory,
            limit
        )
    }

    clearBot(botId){
        const id = Number(botId)
        this.botHistory.delete(id)
        this.botChatHistory.delete(id)
    }

    clearBotEvents(botId){
        this.botHistory.delete(Number(botId))
    }

    clearBotChat(botId){
        this.botChatHistory.delete(Number(botId))
    }

    clearSystem(){
        this.systemHistory = []
    }

    destroy(){
        this.eventBus.offAny(this.onEvent)
        this.botHistory.clear()
        this.botChatHistory.clear()
        this.systemHistory = []
    }

    #handleEvent(event){
        if(!event || typeof event !== "object") return

        const botId = event.source?.botId

        if(botId !== null && botId !== undefined){
            if(event.type === Events.BOT_CHAT_MESSAGE){
                this.#pushBotChat(Number(botId), event)
            }else{
                this.#pushBotEvent(Number(botId), event)
            }

            return
        }

        this.#push(this.systemHistory, event)
    }

    #pushBotEvent(botId, event){
        if(!this.botHistory.has(botId)){
            this.botHistory.set(botId, [])
        }

        this.#push(
            this.botHistory.get(botId),
            event
        )
    }

    #pushBotChat(botId, event){
        if(!this.botChatHistory.has(botId)){
            this.botChatHistory.set(botId, [])
        }

        this.#push(
            this.botChatHistory.get(botId),
            event
        )
    }

    #push(history, event){
        history.push(structuredClone(event))

        if(history.length > this.limit){
            history.splice(
                0,
                history.length - this.limit
            )
        }
    }

    #getHistory(history, limit){
        if(!history?.length) return []

        const normalizedLimit = Math.min(
            Math.max(
                Number(limit) || this.limit,
                1
            ),
            this.limit
        )

        return structuredClone(
            history.slice(-normalizedLimit)
        )
    }
}