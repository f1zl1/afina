export default class WebSocketApi{
    constructor(){
        this.socket = null
        this.requests = new Map()
        this.reconnectTimer = null
        this.handlers = {
            connection: null,
            connected: null,
            disconnected: null,
            event: null
        }
    }

    setHandlers(handlers = {}){
        this.handlers = {
            ...this.handlers,
            ...handlers
        }
    }

    connect(){
        clearTimeout(this.reconnectTimer)

        const protocol = location.protocol === "https:" ? "wss" : "ws"
        const socket = new WebSocket(`${protocol}://${location.hostname}:4001`)

        this.socket = socket
        this.handlers.connection?.("connecting")

        socket.addEventListener("open", () => {
            if(this.socket !== socket) return
            this.handlers.connection?.("connected")
            this.handlers.connected?.()
        })

        socket.addEventListener("message", message => {
            if(this.socket !== socket) return
            this.#handleMessage(message.data)
        })

        socket.addEventListener("close", () => {
            if(this.socket !== socket) return

            this.socket = null
            this.#rejectPending("WebSocket disconnected")
            this.handlers.connection?.("disconnected")
            this.handlers.disconnected?.()
            this.reconnectTimer = setTimeout(() => this.connect(), 2000)
        })

        socket.addEventListener("error", () => {
            if(this.socket !== socket) return
            this.handlers.connection?.("disconnected")
        })
    }

    request(type, name, payload = {}){
        return this.#sendRequest({
            version: 1,
            id: crypto.randomUUID(),
            type,
            name,
            payload
        }, `Request timed out: ${name}`)
    }

    subscribeBot(botId){
        return this.#subscription("subscribe", botId)
    }

    unsubscribeBot(botId){
        return this.#subscription("unsubscribe", botId)
    }

    isConnected(){
        return this.socket?.readyState === WebSocket.OPEN
    }

    #subscription(type, botId){
        return this.#sendRequest({
            version: 1,
            id: crypto.randomUUID(),
            type,
            scope: "bot",
            botId
        }, "Subscription timed out", true)
    }

    #sendRequest(message, timeoutMessage, rejectOnFailure = false){
        if(!this.isConnected()){
            return Promise.reject(new Error("WebSocket is disconnected"))
        }

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.requests.delete(message.id)
                reject(new Error(timeoutMessage))
            }, message.name?.startsWith("telegram.") ? 120000 : 10000)

            this.requests.set(message.id, {
                resolve: response => {
                    clearTimeout(timeout)

                    if(rejectOnFailure && !response.ok){
                        reject(new Error(response.error?.message ?? "Request failed"))
                        return
                    }

                    resolve(response)
                },
                reject: error => {
                    clearTimeout(timeout)
                    reject(error)
                }
            })

            this.socket.send(JSON.stringify(message))
            if(message.name?.startsWith("telegram.")) message.payload = {}
        })
    }

    #handleMessage(data){
        let message

        try{
            message = JSON.parse(data)
        }catch{
            return
        }

        if(message.type === "response"){
            const pending = this.requests.get(message.requestId)
            if(!pending) return

            this.requests.delete(message.requestId)
            pending.resolve(message)
            return
        }

        if(message.type === "event"){
            this.handlers.event?.(message.event)
        }
    }

    #rejectPending(message){
        for(const pending of this.requests.values()){
            pending.reject(new Error(message))
        }

        this.requests.clear()
    }
}
