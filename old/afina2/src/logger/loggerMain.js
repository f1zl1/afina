import path from "node:path"
import RotatingLogWriter from "./rotatingLogWriter.js"

export default class Logger{
    constructor(config = {}){
        const configuredPath =
            config.path ??
            "./logs/system.log"

        this.baseDirectory =
            config.baseDirectory ??
            path.dirname(configuredPath)

        this.maxBytes =
            config.maxFileSizeBytes ??
            20 * 1024 * 1024

        this.maxEntries =
            config.maxEntriesPerFile ??
            50_000

        this.writers = new Map()
    }

    child(source){
        if(
            typeof source !== "string" ||
            source.trim() === ""
        ){
            throw new Error("Invalid logger name!")
        }

        return new ChildLogger({
            parentLogger: this,
            source,
            metadata: {
                scope: "system",
                botId: null,
                accountId: null,
                workerPid: null
            }
        })
    }

    withContext(metadata = {}){
        return new ChildLogger({
            parentLogger: this,
            source:
                metadata.source ??
                "System",
            metadata: {
                scope:
                    metadata.scope ??
                    "system",
                botId:
                    metadata.botId ??
                    null,
                accountId:
                    metadata.accountId ??
                    null,
                workerPid:
                    metadata.workerPid ??
                    null
            }
        })
    }

    bot({
        botId,
        accountId,
        workerPid = null,
        source = "Bot"
    }){
        return new ChildLogger({
            parentLogger: this,
            source,
            metadata: {
                scope: "bot",
                botId,
                accountId,
                workerPid
            }
        })
    }

    async log({
        source,
        message,
        context = {},
        type = "info",
        scope = "system",
        botId = null,
        accountId = null,
        workerPid = null
    }){
        const entry = {
            timestamp:
                new Date().toISOString(),

            level: type,
            scope,
            source,

            botId,
            accountId,
            workerPid,

            message,
            context
        }

        const writer = this.#getWriter({
            scope,
            botId,
            accountId
        })

        return writer.write(entry)
    }

    #getWriter({
        scope,
        botId,
        accountId
    }){
        if(scope === "bot"){
            return this.#getBotWriter(
                botId,
                accountId
            )
        }

        return this.#getSystemWriter()
    }

    #getSystemWriter(){
        const key = "system"

        let writer =
            this.writers.get(key)

        if(writer){
            return writer
        }

        writer = new RotatingLogWriter({
            directory: path.join(
                this.baseDirectory,
                "system"
            ),
            prefix: "system",
            maxBytes: this.maxBytes,
            maxEntries: this.maxEntries
        })

        this.writers.set(
            key,
            writer
        )

        return writer
    }

    #getBotWriter(botId, accountId){
        const safeBotId =
            this.#safeName(
                botId ?? "unknown"
            )

        const safeAccountId =
            this.#safeName(
                accountId ?? "unknown"
            )

        const key =
            `bot:${safeBotId}:${safeAccountId}`

        let writer =
            this.writers.get(key)

        if(writer){
            return writer
        }

        writer = new RotatingLogWriter({
            directory: path.join(
                this.baseDirectory,
                "bots",
                `bot-${safeBotId}-account-${safeAccountId}`
            ),
            prefix: "bot",
            maxBytes: this.maxBytes,
            maxEntries: this.maxEntries
        })

        this.writers.set(
            key,
            writer
        )

        return writer
    }

    #safeName(value){
        return String(value).replace(
            /[^a-zA-Z0-9_-]/g,
            "_"
        )
    }
}

class ChildLogger{
    constructor({
        parentLogger,
        source,
        metadata
    }){
        this.parentLogger =
            parentLogger

        this.source =
            source

        this.metadata = {
            scope:
                metadata.scope ??
                "system",
            botId:
                metadata.botId ??
                null,
            accountId:
                metadata.accountId ??
                null,
            workerPid:
                metadata.workerPid ??
                null
        }
    }

    child(source){
        if(
            typeof source !== "string" ||
            source.trim() === ""
        ){
            throw new Error("Invalid logger name!")
        }

        return new ChildLogger({
            parentLogger:
                this.parentLogger,

            source:
                `${this.source}:${source}`,

            metadata:
                this.metadata
        })
    }

    withContext(metadata = {}){
        return new ChildLogger({
            parentLogger:
                this.parentLogger,

            source:
                this.source,

            metadata: {
                ...this.metadata,
                ...metadata
            }
        })
    }

    info(message, context = {}){
        return this.#log(
            "info",
            message,
            context
        )
    }

    warn(message, context = {}){
        return this.#log(
            "warn",
            message,
            context
        )
    }

    error(message, context = {}){
        return this.#log(
            "error",
            message,
            context
        )
    }

    #log(type, message, context){
        return this.parentLogger.log({
            source:
                this.source,

            message,
            context,
            type,

            ...this.metadata
        })
    }
}