import { success, failure } from "./coreResult.js"

export default class QueryService{
    constructor({
        logger,
        botManager,
        snapshotStore,
        eventHistoryStore,
        accountPool,
        databaseEditor,
        autonomy
    }){
        this.logger = logger.child("QueryService")
        this.botManager = botManager
        this.autonomy=autonomy
        this.snapshotStore = snapshotStore
        this.eventHistoryStore = eventHistoryStore
        this.accountPool = accountPool

        this.handlers = new Map([
            ['core.market.details',({payload})=>success(autonomy.marketStore.details(payload))],
            ["core.getSnapshot",()=>success(autonomy.snapshot())],
            ["core.decisions.get",({payload})=>success(autonomy.store.decisions(payload.limit ?? 50))],
            ["database.catalog", () => success(databaseEditor.catalog())],
            ["database.read", ({payload}) => success(databaseEditor.read(payload))],
            ["bots.get", context => this.#getBots(context)],
            ["bot.get", context => this.#getBot(context)],
            ["bot.history.get", context => this.#getBotHistory(context)],
            ["bot.chat.history.get", context => this.#getBotChatHistory(context)],
            ["accounts.pool.get", context => this.#getAccountPool(context)],
            ["system.history.get", context => this.#getSystemHistory(context)]
        ])

        this.logger.info("QueryService started")
    }

    async execute({
        query,
        payload = {},
        actor = null
    }){
        if(typeof query !== "string" || !query){
            return failure(
                "INVALID_QUERY",
                "Query must be a non-empty string"
            )
        }

        const handler = this.handlers.get(query)

        if(!handler){
            return failure(
                "QUERY_NOT_FOUND",
                `Unknown query: ${query}`
            )
        }

        try{
            return await handler({
                payload,
                actor
            })
        }catch(error){
            this.logger.error("Query failed", {
                query,
                error: error?.message ?? String(error),
                stack: error?.stack ?? null
            })

            return failure(
                "QUERY_FAILED",
                error?.message ?? String(error)
            )
        }
    }

    #getBots(){
        return success(
            this.botManager.getBotDefinitions().map(definition => ({
                definition,
                snapshot: this.snapshotStore.get(definition.botId),
                proxy:this.autonomy?.proxies.forBot(definition.botId,this.botManager.getBot(definition.botId)?.incarnationId)??null,
                runtime: this.botManager.getBotRuntimeState(definition.botId)
            }))
        )
    }

    #getBot({payload}){
        const botId = this.#botId(payload)
        if(botId === null) return this.#invalidBotId()

        const definition = this.botManager.getBotDefinition(botId)

        if(!definition){
            return failure(
                "BOT_NOT_FOUND",
                `Bot ${botId} not found`
            )
        }

        return success({
            definition,
            snapshot: this.snapshotStore.get(botId),
            proxy:this.autonomy?.proxies.forBot(botId,this.botManager.getBot(botId)?.incarnationId)??null,
            runtime: this.botManager.getBotRuntimeState(botId)
        })
    }

    #getBotHistory({payload}){
        const botId = this.#botId(payload)
        if(botId === null) return this.#invalidBotId()
        if(!this.botManager.hasBot(botId)) return this.#botNotFound(botId)

        return success({
            botId,
            events: this.eventHistoryStore.getBot(
                botId,
                this.#historyLimit(payload.limit)
            )
        })
    }

    #getBotChatHistory({payload}){
        const botId = this.#botId(payload)
        if(botId === null) return this.#invalidBotId()
        if(!this.botManager.hasBot(botId)) return this.#botNotFound(botId)

        return success({
            botId,
            events: this.eventHistoryStore.getBotChat(
                botId,
                this.#historyLimit(payload.limit)
            )
        })
    }

    async #getAccountPool(){
        return success(
            await this.accountPool.getStats()
        )
    }

    #getSystemHistory({payload}){
        return success({
            events: this.eventHistoryStore.getSystem(
                this.#historyLimit(payload.limit)
            )
        })
    }

    #botId(payload){
        const botId = Number(payload?.botId)
        return Number.isInteger(botId) && botId > 0 ? botId : null
    }

    #historyLimit(value){
        if(value === undefined || value === null) return 100

        const limit = Number(value)
        if(!Number.isInteger(limit) || limit < 1) return 100
        return Math.min(limit, 100)
    }

    #invalidBotId(){
        return failure(
            "INVALID_BOT_ID",
            "botId must be a positive integer"
        )
    }

    #botNotFound(botId){
        return failure(
            "BOT_NOT_FOUND",
            `Bot ${botId} not found`
        )
    }
}
