import { randomUUID } from "node:crypto"
import WebSocket from "ws"

export default class WebSocketClient{
    constructor({
        socket,
        logger,
        interfaceGateway
    }){
        this.id = randomUUID()
        this.socket = socket
        this.logger = logger.child("WebSocketClient")
        this.interfaceGateway = interfaceGateway
        this.subscriptions = {
            all: false,
            system: false,
            bots: new Set()
        }
        this.closed = false
    }

    start(){
        this.socket.on("message", data => {
            this.#handleMessage(data).catch(error => {
                this.logger.error("WebSocket message failed", {
                    clientId: this.id,
                    error: error?.message ?? String(error),
                    stack: error?.stack ?? null
                })
            })
        })

        this.socket.on("close", () => {
            this.destroy()
        })

        this.socket.on("error", error => {
            this.logger.warn("WebSocket client error", {
                clientId: this.id,
                error: error?.message ?? String(error)
            })
        })

        this.send({
            version: 1,
            type: "connected",
            clientId: this.id
        })
    }

    send(message){
        if(this.closed || this.socket.readyState !== WebSocket.OPEN) return false

        try{
            this.socket.send(JSON.stringify(message))
            return true
        }catch(error){
            this.logger.warn("WebSocket send failed", {
                clientId: this.id,
                error: error?.message ?? String(error)
            })
            return false
        }
    }

    handleEvent(message){
        if(this.closed) return

        const event = message?.event
        if(!event) return

        if(["system.database.changed", "system.bots.changed"].includes(event.type) || event.type.startsWith("telegram.") || event.type.startsWith("core.")){
            this.send(message)
            return
        }

        if(this.subscriptions.all){
            this.send(message)
            return
        }

        const botId = event.source?.botId

        if(botId !== null && botId !== undefined){
            if(this.subscriptions.bots.has(Number(botId))){
                this.send(message)
            }
            return
        }

        if(this.subscriptions.system){
            this.send(message)
        }
    }

    destroy(){
        if(this.closed) return

        this.closed = true
        this.subscriptions.all = false
        this.subscriptions.system = false
        this.subscriptions.bots.clear()
    }

    async #handleMessage(data){
        if(this.closed) return

        let message

        try{
            message = JSON.parse(data.toString())
        }catch{
            this.#sendError(null, "INVALID_JSON", "Message must contain valid JSON")
            return
        }

        if(message.type === "subscribe"){
            this.#subscribe(message)
            return
        }

        if(message.type === "unsubscribe"){
            this.#unsubscribe(message)
            return
        }

        if(message.type === "ping"){
            this.send({
                version: 1,
                type: "pong",
                requestId: message.id ?? null,
                timestamp: Date.now()
            })
            return
        }

        const response = await this.interfaceGateway.handleRequest(message, {
            type: "web",
            id: this.id
        })

        this.send(response)
    }

    #subscribe(message){
        const scope = message.scope

        if(scope === "all"){
            this.subscriptions.all = true
        }else if(scope === "system"){
            this.subscriptions.system = true
        }else if(scope === "bot"){
            const botId = this.#botId(message.botId)

            if(botId === null){
                this.#sendError(message.id, "INVALID_BOT_ID", "botId must be a positive integer")
                return
            }

            this.subscriptions.bots.add(botId)
        }else{
            this.#sendError(message.id, "INVALID_SUBSCRIPTION", `Unknown subscription scope: ${scope}`)
            return
        }

        this.#sendSubscriptionResponse(message.id, true)
    }

    #unsubscribe(message){
        const scope = message.scope

        if(scope === "all"){
            this.subscriptions.all = false
        }else if(scope === "system"){
            this.subscriptions.system = false
        }else if(scope === "bot"){
            const botId = this.#botId(message.botId)

            if(botId === null){
                this.#sendError(message.id, "INVALID_BOT_ID", "botId must be a positive integer")
                return
            }

            this.subscriptions.bots.delete(botId)
        }else{
            this.#sendError(message.id, "INVALID_SUBSCRIPTION", `Unknown subscription scope: ${scope}`)
            return
        }

        this.#sendSubscriptionResponse(message.id, false)
    }

    #sendSubscriptionResponse(requestId, subscribed){
        this.send({
            version: 1,
            type: "response",
            requestId: requestId ?? null,
            ok: true,
            data: {subscribed}
        })
    }

    #sendError(requestId, code, message){
        this.send({
            version: 1,
            type: "response",
            requestId: requestId ?? null,
            ok: false,
            error: {
                code,
                message,
                details: null
            }
        })
    }

    #botId(value){
        const botId = Number(value)
        return Number.isInteger(botId) && botId > 0 ? botId : null
    }
}
