import { WebSocketServer as WsServer } from "ws"
import WebSocketClient from "./webSocketClient.js"

export default class WebSocketServer{
    constructor({
        logger,
        interfaceGateway,
        port = 4001,
        host = "127.0.0.1",
        allowedOrigins = ["http://127.0.0.1:4000", "http://localhost:4000"]
    }){
        this.logger = logger.child("WebSocketServer")
        this.interfaceGateway = interfaceGateway
        this.port = port
        this.host = host
        this.allowedOrigins = new Set(allowedOrigins)
        this.server = null
        this.clients = new Map()
        this.unsubscribeEvents = null
    }

    start(){
        if(this.server) return false

        this.unsubscribeEvents = this.interfaceGateway.subscribe(message => {
            this.#broadcastEvent(message)
        })

        this.server = new WsServer({
            port: this.port,
            host: this.host,
            maxPayload:1024*1024,
            verifyClient:info => !info.origin || this.allowedOrigins.has(info.origin)
        })

        this.server.on("connection", socket => {
            const client = new WebSocketClient({
                socket,
                logger: this.logger,
                interfaceGateway: this.interfaceGateway
            })

            this.clients.set(client.id, client)
            client.start()

            socket.once("close", () => {
                this.clients.delete(client.id)

                this.logger.info("WebSocket client disconnected", {
                    clientId: client.id,
                    clients: this.clients.size
                })
            })

            this.logger.info("WebSocket client connected", {
                clientId: client.id,
                clients: this.clients.size
            })
        })

        this.server.on("listening", () => {
            this.logger.info("WebSocket server started", {
                host: this.host,
                port: this.port
            })
        })

        this.server.on("error", error => {
            this.logger.error("WebSocket server error", {
                error: error?.message ?? String(error),
                stack: error?.stack ?? null
            })
        })

        return true
    }

    async stop(){
        if(!this.server) return

        const server = this.server
        this.server = null

        if(this.unsubscribeEvents){
            this.unsubscribeEvents()
            this.unsubscribeEvents = null
        }

        for(const client of this.clients.values()){
            client.destroy()

            try{
                client.socket.close()
            }catch{}
        }

        this.clients.clear()

        await new Promise(resolve => {
            server.close(() => resolve())
        })

        this.logger.info("WebSocket server stopped")
    }

    getClientsCount(){
        return this.clients.size
    }

    #broadcastEvent(message){
        for(const client of this.clients.values()){
            client.handleEvent(message)
        }
    }
}
