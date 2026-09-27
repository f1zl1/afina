export default class BotStore{
    constructor(){
        this.bots = new Map()
        this.selectedBotId = null
        this.subscribedBotId = null
        this.refreshTimer = null
        this.syncingBotId = null
        this.syncEvents = []
        this.seenEventIds = new Set()
        this.selectionVersion = 0
    }

    setBots(bots){
        this.bots.clear()

        for(const bot of bots ?? []){
            const snapshot = bot.snapshot
            if(!snapshot) continue

            this.bots.set(snapshot.botId, {
                proxy:bot.proxy??null,
                definition: bot.definition,
                snapshot,
                runtime: bot.runtime ?? null
            })
        }
    }

    setBot(botId, bot){
        this.bots.set(Number(botId), bot)
    }

    getBot(botId = this.selectedBotId){
        return this.bots.get(Number(botId)) ?? null
    }

    startSelection(botId){
        this.selectedBotId = Number(botId)
        this.syncingBotId = this.selectedBotId
        this.syncEvents = []
        this.seenEventIds.clear()
        this.selectionVersion++
        return this.selectionVersion
    }

    finishSync(botId){
        if(this.syncingBotId !== Number(botId)) return []
        const events = this.syncEvents
        this.syncingBotId = null
        this.syncEvents = []
        return events
    }

    queueEvent(event){
        this.syncEvents.push(event)
    }

    rememberEvent(event){
        const id = event?.id
        if(!id) return true
        if(this.seenEventIds.has(id)) return false

        this.seenEventIds.add(id)

        while(this.seenEventIds.size > 1000){
            const first = this.seenEventIds.values().next().value
            this.seenEventIds.delete(first)
        }

        return true
    }

    clearSubscription(){
        this.subscribedBotId = null
    }
}
