export default class MessageEvents{
    constructor({
        botId,
        botActions,
        logger,
        eventBus,
        config
    }){
        this.botId = botId
        this.botActions = botActions
        this.logger = logger
        this.eventBus = eventBus
        this.config = config
    }

    async acceptMessage({message, position, sender}){
        if(!message) return

        // Server echoes must not leak the Minecraft password into public history.
        const password = this.botActions.bot?.accountData?.password
        const raw = message.toString()
        const text = password ? raw.replaceAll(password,"[redacted]") : raw
        const normalized = text.toLowerCase()
        const serverMessage=(position==='system' && !sender) || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(sender ?? '')
        if(serverMessage)this.botActions.bot?.incidents?.handle(text)

        this.eventBus.emit("bot:message", {
            botId: this.botId,
            text
        })

        this.eventBus.emit("bot:chatMessage", {
            botId: this.botId,
            text,
            sender: sender ?? null,
            kind: (position === "system" && !sender) || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(sender ?? "") ? "server" : "chat"
        })

        this.logger.info(`Чат ${this.botId}: ${text}`)

        if(
            normalized.includes("команда недоступна в режиме afk") ||
            normalized.includes("команда недоступна в режиме афк")
        ){
            this.eventBus.emit("bot:afkDetected", {
                botId: this.botId,
                source: "message",
                text
            })

            return
        }

        if(normalized.includes("зарегистрируйтесь")){
            await this.botActions.registrationTask()
            return
        }

        if(
            normalized.includes("успешная авторизация") ||
            normalized.includes("успешная регистрация")
        ){
            await this.botActions.updatePositionStatus("lobby")
            return
        }

        if(
            normalized.includes("добро пожаловать на funtime") ||
            normalized.includes("вы были кикнуты при подключении к серверу anarchy")
        ){
            await this.botActions.connectToRealmTask()
            return
        }

        if(normalized.includes("войдите в игру")){
            await this.botActions.loginingTask()
            return
        }
    }
}
