export default class WorkerLogger{
    child(source){
        if(typeof source !== "string" || source.trim() === ""){
            throw new Error("Invalid logger name!")
        }

        return new WorkerChildLogger(source)
    }
}

class WorkerChildLogger{
    constructor(source){
        this.source = source
    }

    child(source){
        if(typeof source !== "string" || source.trim() === ""){
            throw new Error("Invalid logger name!")
        }

        return new WorkerChildLogger(`${this.source}:${source}`)
    }

    info(message, context = {}){
        return this.#send("info", message, context)
    }

    error(message, context = {}){
        return this.#send("error", message, context)
    }

    warn(message, context = {}){
        return this.#send("warn", message, context)
    }

    #send(level, message, context){
        if(!process.connected) return Promise.resolve(false)

        try{
            process.send({
                type: "log",
                level,
                source: this.source,
                message,
                context
            })

            return Promise.resolve(true)
        }catch{
            return Promise.resolve(false)
        }
    }
}