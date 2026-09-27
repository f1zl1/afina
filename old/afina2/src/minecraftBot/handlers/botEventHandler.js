import MessageEvents from "./botEvents/messageEvents.js"
import ConnectionEvents from "./botEvents/connectionEvents.js"
import ConfigurationEvents from "./botEvents/configurationEvents.js"
import ResourcePackEvents from "./botEvents/resourcePackEvents.js"
import SidebarEvents from "./botEvents/sidebarEvents.js"

import BotActions from "../botActions/botActions.js"

export default class BotEventHandler{
    constructor({
        bot,
        logger,
        eventBus,
        botId
    }){
        this.bot = bot
        this.logger = logger
        this.eventBus = eventBus
        this.botId = botId

        this.config = {
            acceptTeleport: true,
            register: true,
            logMessage: false,
            eventBusMessage: true,
            login: true
        }

        this.botActions = new BotActions({
            bot,
            logger,
            eventBus,
            botId
        })

        this.messageEvents = new MessageEvents({
            botId,
            logger,
            eventBus,
            botActions: this.botActions,
            config: this.config
        })

        this.connectionEvents = new ConnectionEvents({
            bot,
            botId,
            eventBus,
            messageEvents: this.messageEvents
        })

        this.configurationEvents = new ConfigurationEvents({
            bot
        })

        this.resourcePackEvents = new ResourcePackEvents({
            botId,
            eventBus
        })

        this.sidebarEvents = new SidebarEvents({
            bot,
            botId,
            eventBus,
            logger: this.logger
        })
    }

    register(client){
        this.#registerPacketDiagnostics(client)

        this.configurationEvents.register(client)
        this.resourcePackEvents.register(client)
        this.sidebarEvents.register(client)
        this.connectionEvents.register(client)
    }

    #registerPacketDiagnostics(client){
        const protocol = client._client
        if(!protocol) return

        const packetHistory = []

        protocol.on("packet", (data, meta) => {
            packetHistory.push({
                name: meta?.name ?? null,
                id: meta?.id ?? null,
                state: meta?.state ?? null,
                at: Date.now()
            })

            if(packetHistory.length > 50){
                packetHistory.shift()
            }
        })

        protocol.on("error", error => {
            const message = String(error?.message ?? "")

            if(!message.includes("Parse error for play.toClient")){
                return
            }

            console.error(`\n[PACKET PARSE ERROR] Bot ${this.botId}`)
            console.error(error)
            console.error("\n[LAST PACKETS]")

            packetHistory.forEach((packet, index) => {
                console.error(
                    `${index}: name=${packet.name} id=${packet.id} state=${packet.state} at=${packet.at}`
                )
            })

            console.error("[END LAST PACKETS]\n")

            this.eventBus.emit("bot:fatal", {
                botId: this.botId,
                reason: "protocol_parse_error",
                error: error?.message ?? String(error),
                stack: error?.stack ?? null
            })
        })
    }
}