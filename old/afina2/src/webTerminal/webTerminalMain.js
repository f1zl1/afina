import WebSocketServer from "../interfaces/web/webSocketServer.js"
import WebHttpServer from "./webHttpServer.js"

export default class WebTerminal{
    constructor({
        logger,
        interfaceGateway,
        config = {}
    }){
        this.logger = logger.child("WebTerminal")
        this.interfaceGateway = interfaceGateway
        this.config = {
            httpHost: config.httpHost ?? "127.0.0.1",
            httpPort: config.httpPort ?? 4000,
            webSocketHost: config.webSocketHost ?? "127.0.0.1",
            webSocketPort: config.webSocketPort ?? 4001
        }
        this.httpServer = null
        this.webSocketServer = null
        this.started = false
    }

    init(){
        if(this.started) return false

        this.httpServer = new WebHttpServer({
            logger: this.logger,
            host: this.config.httpHost,
            port: this.config.httpPort
        })

        this.webSocketServer = new WebSocketServer({
            logger: this.logger,
            interfaceGateway: this.interfaceGateway,
            host: this.config.webSocketHost,
            port: this.config.webSocketPort,
            allowedOrigins:[`http://${this.config.httpHost}:${this.config.httpPort}`,`http://localhost:${this.config.httpPort}`]
        })

        this.httpServer.start()
        this.webSocketServer.start()
        this.started = true

        this.logger.info("WebTerminal started", {
            http: {
                host: this.config.httpHost,
                port: this.config.httpPort
            },
            webSocket: {
                host: this.config.webSocketHost,
                port: this.config.webSocketPort
            }
        })

        return true
    }

    async stop(){
        if(!this.started) return

        this.started = false

        await Promise.all([
            this.httpServer?.stop(),
            this.webSocketServer?.stop()
        ])

        this.httpServer = null
        this.webSocketServer = null

        this.logger.info("WebTerminal stopped")
    }

    getClientsCount(){
        return this.webSocketServer?.getClientsCount() ?? 0
    }
}
